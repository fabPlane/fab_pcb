// Registers happy-dom as the global DOM for `bun test`.
// Loaded via bunfig.toml preload when run from apps/web, and imported explicitly by
// every test file so `bun test` from the workspace root behaves the same.
import { GlobalRegistrator } from '@happy-dom/global-registrator';

if (!GlobalRegistrator.isRegistered) {
  GlobalRegistrator.register({ url: 'http://localhost/' });
}
