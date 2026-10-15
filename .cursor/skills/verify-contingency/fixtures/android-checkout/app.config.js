// Each variant is a separate build of one Target App. Contingency compares the
// versionCode as appBuild, so a changed build needs Run Environment Permission.
const variants = { broken: 3, changed: 2, working: 1 };
const variant = process.env.FIXTURE_VARIANT ?? "working";
if (!(variant in variants)) {
  throw new Error(
    `FIXTURE_VARIANT must be one of ${Object.keys(variants).join(", ")}`
  );
}

// Expo loads this file with require(), so it stays CommonJS.
// oxlint-disable-next-line unicorn/prefer-module
module.exports = {
  android: {
    package: "dev.contingency.checkout",
    versionCode: variants[variant],
  },
  extra: { fixtureVariant: variant },
  name: "Fixture Shop",
  orientation: "portrait",
  platforms: ["android"],
  slug: "contingency-android-checkout-fixture",
  userInterfaceStyle: "light",
  version: `${variants[variant]}.0.0`,
};
