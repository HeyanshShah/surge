import { City, type CityData } from '../src/city';
import { FloodModel } from '../src/flood';
import { buildReplay } from '../src/replay';
import { Router } from '../src/routing';

export function makeReplay(cityJson: string, seed: number) {
  const city = new City(JSON.parse(cityJson) as CityData);
  const flood = new FloodModel(city);
  return buildReplay(city, flood, new Router(city, flood), seed);
}
