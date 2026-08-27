declare module "playwright-core/lib/utilsBundle" {
  import type { Readable } from "node:stream";

  interface ZipEntry {
    readonly fileName: string;
  }

  interface ReadZipFile {
    readonly eachEntry: () => AsyncIterable<ZipEntry>;
    readonly openReadStreamPromise: (entry: ZipEntry) => Promise<Readable>;
  }

  interface WriteZipFile {
    readonly outputStream: Readable;
    readonly addBuffer: (buffer: Buffer, fileName: string) => void;
    readonly end: () => void;
  }

  export const yauzl: {
    readonly openPromise: (
      file: string,
      options: { readonly lazyEntries: true }
    ) => Promise<ReadZipFile>;
  };

  export const yazl: {
    readonly ZipFile: new () => WriteZipFile;
  };
}
