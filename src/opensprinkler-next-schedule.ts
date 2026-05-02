/**
 * next-schedule.ts
 * Calcula la próxima ejecución planificada para una estación,
 * leyendo directamente las entidades de la integración hass-opensprinkler.
 *
 * Estrategia por tipo de programa:
 *   - weekly:   calculamos el próximo día activo con los switches lun-dom
 *   - interval: usamos number.X_starting_in_days (fiable para este tipo)
 *
 * Entidades usadas por programa (prefijo = entity_id sin 'switch.' y sin '_program_enabled'):
 *   switch.PREFIX_program_enabled            → habilitado/deshabilitado
 *   switch.PREFIX_program_use_weather        → usa ajuste climático
 *   select.PREFIX_type                       → weekly | interval
 *   time.PREFIX_start_time                   → hora de inicio principal
 *   number.PREFIX_start_time_repeat_count    → número de repeticiones
 *   number.PREFIX_start_time_repeat_interval → intervalo entre repeticiones (min)
 *   number.PREFIX_starting_in_days           → días hasta próxima ejecución (solo interval)
 *   switch.PREFIX_monday_enabled             → lunes activo (solo weekly)
 *   switch.PREFIX_tuesday_enabled            → martes activo (solo weekly)
 *   switch.PREFIX_wednesday_enabled          → miércoles activo (solo weekly)
 *   switch.PREFIX_thursday_enabled           → jueves activo (solo weekly)
 *   switch.PREFIX_friday_enabled             → viernes activo (solo weekly)
 *   switch.PREFIX_saturday_enabled           → sábado activo (solo weekly)
 *   switch.PREFIX_sunday_enabled             → domingo activo (solo weekly)
 *   number.PREFIX_STATION_station_duration   → duración base de la estación (seg)
 *
 * Entidades globales:
 *   sensor.opensprinkler_water_level         → water level % actual
 *   sensor.opensprinkler_current_time        → hora actual del dispositivo
 */

import { HomeAssistant } from 'custom-card-helpers';

/** Información sobre la próxima ejecución de una estación */
export interface NextRunInfo {
  date: Date;               // próxima fecha/hora de ejecución
  programName: string;      // nombre del programa que la ejecuta
  isRepeat: boolean;        // true = tiene repeticiones, false = horario único
  repetitions: number;      // número de repeticiones (1 si no hay)
  intervalMinutes: number;  // minutos entre repeticiones (0 si no hay)
  duration: number;         // duración base en segundos
  durationAdjusted: number; // duración ajustada por wl
  usesWeather: boolean;     // usa ajuste climático
  wl: number;               // water level % aplicado
}

/** Días de la semana en orden lun-dom */
const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

/** Construye el entity_id de la duración de una estación en un programa */
function durationEntityId(prefix: string, stationName: string): string {
  return `number.${prefix}_${stationName}_station_duration`;
}

/** Lee el estado numérico de una entidad. Devuelve null si no existe o no es válido */
function getNumber(hass: HomeAssistant, entityId: string): number | null {
  const state = hass.states[entityId]?.state;
  if (!state || state === 'unavailable' || state === 'unknown') return null;
  const n = parseFloat(state);
  return isNaN(n) ? null : n;
}

/** Lee el estado de una entidad como string. Devuelve null si no existe */
function getString(hass: HomeAssistant, entityId: string): string | null {
  const state = hass.states[entityId]?.state;
  if (!state || state === 'unavailable' || state === 'unknown') return null;
  return state;
}

/** Lee el estado de un switch como boolean. Devuelve false si no existe */
function getSwitch(hass: HomeAssistant, entityId: string): boolean {
  return hass.states[entityId]?.state === 'on';
}

/** Convierte "HH:MM:SS" o "HH:MM" a minutos desde medianoche */
function timeToMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

/**
 * Busca la próxima repetición no pasada para un día concreto.
 * Para daysAhead > 0 siempre devuelve startMin (primer inicio del día).
 * Para daysAhead = 0 itera las repeticiones buscando la primera que no haya pasado.
 *
 * @param startMin      - primer inicio en minutos desde medianoche
 * @param repeatCount   - número de repeticiones (0 = sin repeticiones)
 * @param repeatInterval - minutos entre repeticiones
 * @param nowMin        - minuto actual del día
 * @param daysAhead     - días de adelanto respecto a hoy (0 = hoy)
 * @returns minutos desde medianoche de la próxima repetición, o null si todas pasaron
 */
function findNextStartMin(
  startMin: number,
  repeatCount: number,
  repeatInterval: number,
  nowMin: number,
  daysAhead: number
): number | null {
  if (daysAhead > 0) {
    // Día futuro → siempre el primer inicio
    return startMin;
  }

  // Hoy → buscar la primera repetición que no haya pasado
  const totalReps = repeatCount > 0 ? repeatCount + 1 : 1; // +1 porque la primera no cuenta como repetición
  for (let n = 0; n < totalReps; n++) {
    const repMin = startMin + n * (repeatInterval || 0);
    if (repMin > nowMin) return repMin;
  }

  // Todas las repeticiones de hoy han pasado
  return null;
}

/**
 * Calcula los días hasta el próximo día activo para un programa semanal.
 * Lee los días activos desde number.PREFIX_interval_days como bitmask
 * (bit0=Lun, bit1=Mar, bit2=Mie, bit3=Jue, bit4=Vie, bit5=Sab, bit6=Dom).
 * Si hoy es día activo pero todas las repeticiones pasaron, busca el siguiente día activo.
 *
 * @param hass           - instancia de HomeAssistant
 * @param prefix         - prefijo del programa
 * @param startMin       - hora de inicio en minutos desde medianoche
 * @param repeatCount    - número de repeticiones
 * @param repeatInterval - minutos entre repeticiones
 * @param nowMin         - minuto actual del día
 * @returns { daysAhead, effectiveStartMin } días hasta la próxima ejecución y hora efectiva, o null si no hay días activos
 */
function nextWeeklyRun(
  hass: HomeAssistant,
  prefix: string,
  startMin: number,
  repeatCount: number,
  repeatInterval: number,
  nowMin: number
): { daysAhead: number; effectiveStartMin: number } | null {
  // Días activos como bitmask desde number.X_interval_days
  // bit0=Lun, bit1=Mar, bit2=Mie, bit3=Jue, bit4=Vie, bit5=Sab, bit6=Dom
  const daysBitmask = getNumber(hass, `number.${prefix}_starting_in_days`) ?? 127;

  // Date.getDay(): 0=Dom..6=Sab → convertimos a 0=Lun..6=Dom
  const todayJs  = new Date().getDay();
  const todayDow = todayJs === 0 ? 6 : todayJs - 1;
  console.log('todayJs:', todayJs, 'todayDow:', todayDow, 'daysBitmask:', daysBitmask, 'bit check:', ((daysBitmask >> todayDow) & 1));
  for (let i = 0; i < 7; i++) {
    const checkDow = (todayDow + i) % 7;
    const isActive = ((daysBitmask >> checkDow) & 1) === 1;
    console.log('weekly check - i:', i, 'checkDow:', checkDow, 'isActive:', isActive, 'startMin:', startMin, 'nowMin:', nowMin);

    if (!isActive) continue;

    const effectiveStartMin = findNextStartMin(startMin, repeatCount, repeatInterval, nowMin, i);
    console.log('effectiveStartMin:', effectiveStartMin);
    if (effectiveStartMin === null) continue;

    return { daysAhead: i, effectiveStartMin };
  }

  return null;
}

/**
 * Calcula los días hasta la próxima ejecución para un programa de intervalo.
 * Tiene en cuenta si todas las repeticiones de hoy ya pasaron.
 *
 * @param hass           - instancia de HomeAssistant
 * @param prefix         - prefijo del programa
 * @param startMin       - hora de inicio en minutos desde medianoche
 * @param repeatCount    - número de repeticiones
 * @param repeatInterval - minutos entre repeticiones
 * @param nowMin         - minuto actual del día
 * @returns { daysAhead, effectiveStartMin } o null si no se puede calcular
 */
function nextIntervalRun(
  hass: HomeAssistant,
  prefix: string,
  startMin: number,
  repeatCount: number,
  repeatInterval: number,
  nowMin: number
): { daysAhead: number; effectiveStartMin: number } | null {
  const startingIn = getNumber(hass, `number.${prefix}_starting_in_days`);
  if (startingIn === null) return null;

  // Si no es hoy, el primer inicio del día es la hora efectiva
  if (startingIn > 0) {
    return { daysAhead: startingIn, effectiveStartMin: startMin };
  }

  // Es hoy (startingIn = 0) → buscar próxima repetición no pasada
  const effectiveStartMin = findNextStartMin(startMin, repeatCount, repeatInterval, nowMin, 0);
  if (effectiveStartMin !== null) {
    return { daysAhead: 0, effectiveStartMin };
  }

  // Todas las repeticiones de hoy pasaron → siguiente ciclo
  const intervalDays = getNumber(hass, `number.${prefix}_interval_days`) ?? 1;
  return { daysAhead: intervalDays, effectiveStartMin: startMin };
}

/**
 * Función principal: busca en todos los programas habilitados de HA
 * cuál es la próxima ejecución para una estación dada.
 *
 * @param hass        - instancia de HomeAssistant
 * @param stationName - nombre normalizado de la estación (ej: "depuradora", "zona_salon")
 * @returns NextRunInfo con toda la información, o null si no hay ejecución programada
 */
export function getNextRun(
  hass: HomeAssistant,
  stationName: string
): NextRunInfo | null {
  // Water level actual
  const wl = getNumber(hass, 'sensor.opensprinkler_water_level') ?? 100;

  // Hora actual del dispositivo
  const currentTimeStr = getString(hass, 'sensor.opensprinkler_current_time');
  const nowMin = currentTimeStr
    ? timeToMinutes(currentTimeStr)
    : timeToMinutes(new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }));

  // Buscar todos los programas habilitados
  const programSwitches = Object.entries(hass.states).filter(([entityId, state]) =>
    entityId.startsWith('switch.') &&
    entityId.endsWith('_program_enabled') &&
    state.attributes?.opensprinkler_type === 'program'
  );
  console.log('programSwitches encontrados:', programSwitches.map(([id]) => id));
  console.log('buscando stationName:', stationName);
  let earliest: NextRunInfo | null = null;

  for (const [switchEntityId, switchState] of programSwitches) {
    // Ignorar programas deshabilitados
    if (switchState.state !== 'on') continue;

    // Extraer prefijo
    const prefix = switchEntityId
      .replace(/^switch\./, '')
      .replace(/_program_enabled$/, '');

    const programName = switchState.attributes?.name as string ?? prefix;

    // Duración base de la estación en este programa (en segundos)
    const durationId = durationEntityId(prefix, stationName);
    const baseDuration = getNumber(hass, durationId);
    console.log('prefix:', prefix, 'durationId:', durationId, 'baseDuration:', baseDuration, 'enabled:', switchState.state);
    if (!baseDuration || baseDuration === 0) continue; // estación no está en este programa

    // Tipo de programa
    const type = getString(hass, `select.${prefix}_type`);
    console.log('type:', type, 'select entity:', `select.${prefix}_type`);

    if (!type) continue;

    // Hora de inicio principal
    const startTimeStr = getString(hass, `time.${prefix}_start_time`);
    console.log('startTimeStr:', startTimeStr);
    if (!startTimeStr) continue;
    const startMin = timeToMinutes(startTimeStr);

    // Repeticiones
    const repeatCount    = getNumber(hass, `number.${prefix}_start_time_repeat_count`) ?? 0;
    const repeatInterval = getNumber(hass, `number.${prefix}_start_time_repeat_interval`) ?? 0;
    console.log('repeatCount:', repeatCount, 'repeatInterval:', repeatInterval);
    const isRepeat       = repeatCount > 0 && repeatInterval > 0;

    // Calcular próxima ejecución según tipo
    let result: { daysAhead: number; effectiveStartMin: number } | null = null;

    if (type.toLowerCase() === 'weekly') {
    result = nextWeeklyRun(hass, prefix, startMin, repeatCount, repeatInterval, nowMin);
    } else if (type.toLowerCase() === 'interval') {
    result = nextIntervalRun(hass, prefix, startMin, repeatCount, repeatInterval, nowMin);
    }
    if (!result) continue;

    // Construir la fecha de la próxima ejecución
    const next = new Date();
    next.setDate(next.getDate() + result.daysAhead);
    next.setHours(Math.floor(result.effectiveStartMin / 60), result.effectiveStartMin % 60, 0, 0);

    // ¿Es más próximo que el candidato actual?
    if (earliest !== null && next >= earliest.date) continue;

    // Duración ajustada por water level si usa weather
    const useWl            = getSwitch(hass, `switch.${prefix}_program_use_weather`);
    const durationAdjusted = useWl
      ? Math.round(baseDuration * (wl / 100))
      : baseDuration;

    earliest = {
      date:            next,
      programName,
      isRepeat,
      repetitions:     isRepeat ? repeatCount : 1,
      intervalMinutes: isRepeat ? repeatInterval : 0,
      duration:        baseDuration,
      durationAdjusted,
      usesWeather:     useWl,
      wl,
    };
  }

  return earliest;
}

/**
 * Formatea el NextRunInfo en texto legible en español.
 *
 * @param info - NextRunInfo devuelto por getNextRun (o null)
 */
export function formatNextRun(info: NextRunInfo | null): string {
  if (!info) return '';

  const now       = new Date();
  const diffMs    = info.date.getTime() - now.getTime();
  const diffMin   = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMin / 60);

  const timeStr = info.date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  // Cuándo
  let when: string;
  if (diffMin < 60)        when = `En ${diffMin} min`;
  else if (diffHours < 24) when = `Hoy a las ${timeStr}`;
  else if (diffHours < 48) when = `Mañana a las ${timeStr}`;
  else                     when = `${info.date.toLocaleDateString()} a las ${timeStr}`;

  // Duración
  const durationMin = Math.round(info.durationAdjusted);
  const durationStr = info.isRepeat && info.repetitions > 1
    ? `${info.repetitions}× ~${durationMin} min`
    : `~${durationMin} min`;

  return `${when} · ${durationStr}`;
}