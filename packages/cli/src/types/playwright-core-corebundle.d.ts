declare module "playwright-core/lib/coreBundle" {
  /**
   * The slice of Playwright's own npm-install machinery the CLI reuses to
   * download its browser on first use. The path is an exported surface of the
   * package; only what is consumed is declared.
   */
  export const registry: {
    readonly installBrowsersForNpmInstall: (
      browsers: readonly string[]
    ) => Promise<boolean>;
    readonly browserDirectoryToMarkerFilePath: (directory: string) => string;
    readonly registry: {
      readonly findExecutable: (name: string) => {
        readonly directory: string;
      };
    };
  };
}
