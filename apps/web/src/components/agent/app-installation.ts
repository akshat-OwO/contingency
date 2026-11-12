/**
 * The question an app-installation decision asks: install a missing Target
 * App, or replace the build already on the device. Refusing leaves the
 * device unchanged.
 */
export const appInstallationQuestion = ({
  app,
  build,
  device,
  installedBuild,
}: {
  readonly app: string;
  readonly build: string;
  readonly device: string;
  readonly installedBuild: string | null | undefined;
}) =>
  installedBuild === null || installedBuild === undefined
    ? `Install build ${build} of ${app} on ${device}?`
    : `Replace build ${installedBuild} with build ${build} of ${app} on ${device}?`;
