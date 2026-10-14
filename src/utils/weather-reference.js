/* 天气参考（可选）：基于 Open-Meteo 公开接口的纯数据工具。
 * 约定：
 * 1. 本模块只做“构造请求 URL / 校验响应 / 归一展示值”，不接触 DOM、不自动刷新；
 * 2. 一切网络请求由页面显式动作触发，fetch 实现可注入，方便自检用假响应覆盖；
 * 3. 返回结果只是接口播报的参考值，绝不推导“可否飞行”之类结论，也不改动任何人工勾选。
 */

export const WEATHER_ENDPOINT = 'https://api.open-meteo.com/v1/forecast'
const WEATHER_FIELDS = 'temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m,wind_gusts_10m'

/* WMO 4677 天气代码（Open-Meteo 采用的编码）→ 中文描述。未收录的代码如实标“未知”，不猜。 */
const WMO_CODES = Object.freeze({
  0: '晴',
  1: '基本晴',
  2: '局部多云',
  3: '阴',
  45: '雾',
  48: '冻雾',
  51: '轻毛毛雨',
  53: '毛毛雨',
  55: '浓毛毛雨',
  56: '轻冻毛毛雨',
  57: '冻毛毛雨',
  61: '小雨',
  63: '中雨',
  65: '大雨',
  66: '轻冻雨',
  67: '冻雨',
  71: '小雪',
  73: '中雪',
  75: '大雪',
  77: '雪粒',
  80: '小阵雨',
  81: '阵雨',
  82: '强阵雨',
  85: '小雪阵',
  86: '强雪阵',
  95: '雷暴',
  96: '雷暴伴小冰雹',
  99: '雷暴伴大冰雹',
})

export function describeWeatherCode(code) {
  if (typeof code !== 'number' || !Number.isFinite(code)) return '未知'
  return WMO_CODES[code] ?? `未知天气代码 ${code}`
}

export function buildWeatherUrl(latitude, longitude) {
  const lat = latitude
  const lon = longitude
  if (typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90)
    throw new TypeError('纬度必须是 -90 到 90 之间的数字')
  if (typeof lon !== 'number' || !Number.isFinite(lon) || lon < -180 || lon > 180)
    throw new TypeError('经度必须是 -180 到 180 之间的数字')
  /* 坐标最多保留 4 位小数（约 11 米），接口不需要更高的精度 */
  const q = new URLSearchParams({
    latitude: lat.toFixed(4),
    longitude: lon.toFixed(4),
    current: WEATHER_FIELDS,
    wind_speed_unit: 'ms',
  })
  return `${WEATHER_ENDPOINT}?${q.toString()}`
}

/* 数值归一：保留合法的 0；缺失/非有限值返回 null，绝不补默认数。 */
function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function parseWeatherResponse(payload) {
  const current = payload && typeof payload === 'object' ? payload.current : null
  if (!current || typeof current !== 'object') return { ok: false, error: '接口响应缺少 current 字段' }
  const temperatureC = numberOrNull(current.temperature_2m)
  const windSpeedMs = numberOrNull(current.wind_speed_10m)
  if (temperatureC === null || windSpeedMs === null) return { ok: false, error: '接口响应缺少气温或风速字段' }
  return {
    ok: true,
    data: {
      temperatureC,
      humidityPercent: numberOrNull(current.relative_humidity_2m),
      weatherCode: numberOrNull(current.weather_code),
      weatherText: describeWeatherCode(current.weather_code),
      windSpeedMs,
      windGustMs: numberOrNull(current.wind_gusts_10m),
      observedAt: typeof current.time === 'string' ? current.time : '',
    },
  }
}

/* 唯一发起网络请求的出口：fetch 由参数注入，失败一律返回 {ok:false,error}，不抛进页面流程。 */
export async function fetchWeatherReference({ latitude, longitude, fetchImpl, signal, timeoutMs = 10000 } = {}) {
  let url
  try {
    url = buildWeatherUrl(latitude, longitude)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : null
  if (!doFetch) return { ok: false, error: '当前环境没有可用的 fetch 实现' }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const onOuterAbort = () => controller.abort()
  if (signal) {
    if (signal.aborted) {
      clearTimeout(timer)
      return { ok: false, error: '查询已取消' }
    }
    signal.addEventListener('abort', onOuterAbort, { once: true })
  }
  try {
    const response = await doFetch(url, { signal: controller.signal })
    if (!response || response.ok !== true) {
      return { ok: false, error: `天气接口返回 HTTP ${response && response.status != null ? response.status : '异常'}` }
    }
    let payload
    try {
      payload = await response.json()
    } catch {
      return { ok: false, error: '天气接口响应不是合法 JSON' }
    }
    return parseWeatherResponse(payload)
  } catch (error) {
    const aborted = error && (error.name === 'AbortError' || controller.signal.aborted)
    return {
      ok: false,
      error: aborted
        ? '天气查询超时或已取消'
        : `天气接口不可达：${error instanceof Error ? error.message : String(error)}`,
    }
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onOuterAbort)
  }
}
