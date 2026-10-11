import { City, type CityData } from '../src/city';
import { FloodModel } from '../src/flood';
import { buildReplay } from '../src/replay';
import { Router } from '../src/routing';

// Runs a fresh storm off the main thread so the map keeps animating.
self.onmessage = (e: MessageEvent<{ city: string; seed: number }>) => {
  const city = new City(JSON.parse(e.data.city) as CityData);
  const flood = new FloodModel(city);
  const router = new Router(city, flood);
  let last = 0;
  const replay = buildReplay(city, flood, router, e.data.seed, (f) => {
    if (f - last >= 0.02) {
      last = f;
      (self as unknown as Worker).postMessage({ progress: f });
    }
  });
  (self as unknown as Worker).postMessage({ replay });
};
