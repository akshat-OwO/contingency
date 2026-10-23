/** Pins are release-owned. Never resolve a moving upstream branch at setup time. */
export const LOCAL_SYSTEM_ONE_RELEASE = {
  kevCommit: "2074cc44256200bb37540103fa4572901faa10f3",
  kevSha256: "d5dda4b2631afed7b458b77ce01084197b27dfdfa36dbb39dfe9b8108d8cf059",
  models: {
    nev: {
      id: "akshat-OwO/nev-0.8b",
      revision: "2cdfac694d3d61fe9ef1a5156ff8d521930ca350",
    },
  },
  sizes: {
    // Apple Silicon, Python 3.13: tarball + fetched wheel archives + HF blobs.
    // Disk is du -sk of the owned directory after the setup smoke request.
    darwin: {
      diskBytes: 4_968_837_120,
      downloadBytes: 2_239_757_880,
      measured: true,
    },
    linux: {
      diskBytes: 16_000_000_000,
      downloadBytes: 8_000_000_000,
      measured: false,
    },
  },
  tarballBytes: 140_955_321,
} as const;

export const LOCAL_SYSTEM_ONE_MODELS = ["nev"] as const;
