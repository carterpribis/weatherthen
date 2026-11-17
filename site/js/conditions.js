// Turn a day of 20th Century Reanalysis detail values at one point into words.
//
// Checked against New York Central Park's 1888 records (pipeline/validate_station.py):
// the reanalysis catches 95% of wet days but drizzles on too many others, so a day
// needs at least 1 mm before it is called wet.

const WET_MM = 1;

/** d: {precip, snow_frac, frz_frac, cloud, u10, v10, tmax} -> {text, icon} */
export function classifyDay(d) {
  const wind = Math.hypot(d.u10, d.v10);
  let text, icon;

  if (d.precip >= WET_MM) {
    const snowy = d.snow_frac >= 0.5 || (d.tmax < 0 && d.snow_frac > 0.1);
    if (d.frz_frac >= 0.25) {
      text = 'Freezing rain'; icon = '🧊';
    } else if (snowy) {
      text = d.precip >= 10 ? 'Heavy snow' : d.precip >= 3 ? 'Snow' : 'Light snow';
      icon = d.precip >= 10 ? '❄️' : '🌨️';
    } else if (d.snow_frac >= 0.15) {
      text = 'Rain and snow'; icon = '🌨️';
    } else {
      text = d.precip >= 15 ? 'Heavy rain' : d.precip >= 5 ? 'Rain' : 'Light rain';
      icon = d.precip >= 5 ? '🌧️' : '🌦️';
    }
  } else if (d.cloud < 20) {
    text = 'Clear'; icon = '☀️';
  } else if (d.cloud < 45) {
    text = 'Mainly clear'; icon = '🌤️';
  } else if (d.cloud < 75) {
    text = 'Partly cloudy'; icon = '⛅';
  } else {
    text = 'Cloudy'; icon = '☁️';
  }

  if (wind >= 14) text += ', very windy';
  else if (wind >= 9) text += ', windy';
  return { text, icon };
}

/** Direction the wind blows FROM, in degrees, for a mean (u, v) vector. */
export function windFrom(u, v) {
  return (Math.atan2(-u, -v) * 180 / Math.PI + 360) % 360;
}
