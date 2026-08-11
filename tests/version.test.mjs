import assert from "node:assert";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

// package.json is the single source of the app version. appinfo.json is stamped
// from it at build time, but the checked-in copy should not drift either — the
// UI badge sat five releases behind the installed app once because all three
// copies were maintained by hand.
const pkg = JSON.parse(read("package.json"));
const appinfo = JSON.parse(read("appinfo.json"));
assert.match(pkg.version, /^\d+\.\d+\.\d+$/, "package.json needs a semver version");
assert.strictEqual(
  appinfo.version,
  pkg.version,
  `appinfo.json (${appinfo.version}) must match package.json (${pkg.version})`,
);

// The frontend must take the version from the injected define, never from a
// literal that someone has to remember to bump.
const connectForm = read("src/connect-form.js");
assert.match(
  connectForm,
  /__APP_VERSION__/,
  "connect-form.js must read the injected __APP_VERSION__",
);
assert.doesNotMatch(
  connectForm,
  /APP_VERSION\s*=\s*"v\d/,
  "connect-form.js must not hard-code a version literal",
);

// ...and the build must actually inject it.
assert.match(
  pkg.scripts["build:frontend"],
  /--define:__APP_VERSION__/,
  "build:frontend must define __APP_VERSION__",
);

console.log("version tests passed");
