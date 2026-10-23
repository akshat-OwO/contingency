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
    // Full installation measurements require a system Python 3.12/3.13.
    // This development machine has only 3.14; do not present estimates as measured.
    darwin: {
      diskBytes: 9_000_000_000,
      downloadBytes: 4_000_000_000,
      measured: false,
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
