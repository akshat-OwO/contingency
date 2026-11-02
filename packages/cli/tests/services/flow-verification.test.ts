import path from "node:path";

import { FlowSkillName } from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";

import {
  CatalogBrowser,
  makeCatalogBrowserLayer,
} from "../../src/services/catalog-browser.ts";
import {
  FlowSkillCatalog,
  makeFlowSkillCatalogLayer,
} from "../../src/services/flow-skill-catalog.ts";
import {
  FLOW_CONTRACT_FILES,
  flowVerificationDigests,
  stampFlowSkillProvenance,
  stampFlowVerification,
} from "../../src/services/flow-skill-package.ts";
import {
  isVerifiedFlowSkill,
  readRequestedSkills,
} from "../../src/services/requested-flow-skills.ts";

const procedure =
  "---\nname: example\ndescription: Open the shop.\ninputs:\n  - city\n---\n\n1. Open the shop. Done when: the shop is visible.\n";
const verification = {
  completedAt: "2026-11-02",
  inputs: [],
  observableOutcome: "Shop visible",
  outcome: "passed" as const,
  platform: "web" as const,
  verifiedAt: "2026-11-02",
};
const contracts = FLOW_CONTRACT_FILES.map((name) => ({
  content: "{}\n",
  path: name,
}));

it.effect(
  "edits update MCP listings, the drawer, and Run startup without writing the Flow",
  () =>
    Effect.gen(function* verifyEdits() {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const directory = path.join(root, "example");
      yield* fs.makeDirectory(directory);
      const content = stampFlowVerification(procedure, verification, contracts);
      const baseline = [
        { content, path: "flow.md" },
        ...contracts,
        { content: "# Setup\n", path: "setup.md" },
      ];
      const mutations = [
        {
          content: content.replace(
            "Open the shop. Done",
            "Close the shop. Done"
          ),
          file: "flow.md",
          name: "procedure",
          verified: false,
        },
        ...FLOW_CONTRACT_FILES.map((file) => ({
          content: '{"changed":true}\n',
          file,
          name: file,
          verified: false,
        })),
        {
          content: "# Different setup\n",
          file: "setup.md",
          name: "supporting document",
          verified: true,
        },
        { content, file: "flow.md", name: "unchanged", verified: true },
        {
          content: procedure.replace(
            "name:",
            `verification: ${JSON.stringify(verification)}\nname:`
          ),
          file: "flow.md",
          name: "legacy stamp",
          verified: false,
        },
      ];
      yield* Effect.gen(function* readSurfaces() {
        const catalog = yield* FlowSkillCatalog;
        const browser = yield* CatalogBrowser;
        for (const mutation of mutations) {
          for (const file of baseline) {
            yield* fs.writeFileString(
              path.join(directory, file.path),
              file.content
            );
          }
          const target = path.join(directory, mutation.file);
          yield* fs.writeFileString(target, mutation.content);
          expect(
            (yield* catalog.list()).flowSkills[0]?.verified,
            mutation.name
          ).toBe(mutation.verified);
          expect(
            (yield* browser.browse()).roots[0]?.flowSkills[0]?.verified,
            mutation.name
          ).toBe(mutation.verified);
          const startup = yield* Effect.result(
            readRequestedSkills([FlowSkillName.make("example")])
          );
          expect(startup._tag, mutation.name).toBe(
            mutation.verified ? "Success" : "Failure"
          );
          expect(yield* fs.readFileString(target)).toBe(mutation.content);
        }
      }).pipe(
        Effect.provide(
          makeCatalogBrowserLayer({
            globalRoot: undefined,
            localRoot: () => root,
          })
        ),
        Effect.provide(makeFlowSkillCatalogLayer({ root }))
      );
    }).pipe(Effect.provide(NodeServices.layer))
);

it("invalidates verification when contracts are added or removed", () => {
  const content = stampFlowVerification(procedure, verification, contracts);
  expect(
    isVerifiedFlowSkill([{ content, path: "flow.md" }, ...contracts.slice(1)])
  ).toBe(false);
  const absent = stampFlowVerification(procedure, verification);
  expect(
    isVerifiedFlowSkill([
      { content: absent, path: "flow.md" },
      { content: "{}", path: "checks.json" },
    ])
  ).toBe(false);
});

it("keeps digests stable across verification and provenance stamps and CRLF", () => {
  const expected = flowVerificationDigests(procedure, contracts);
  const provenance = stampFlowSkillProvenance(procedure, {
    emulation: null,
    hosts: ["shop.example.com"],
  });
  const first = stampFlowVerification(provenance, verification, contracts);
  const second = stampFlowVerification(
    first,
    { ...verification, verifiedAt: "later" },
    contracts
  );
  expect(flowVerificationDigests(second, contracts)).toEqual(expected);
  expect(
    flowVerificationDigests(
      second.replaceAll("\n", "\r\n"),
      contracts.map((file) => ({
        ...file,
        content: file.content.replaceAll("\n", "\r\n"),
      }))
    )
  ).toEqual(expected);
  expect(
    isVerifiedFlowSkill([{ content: second, path: "flow.md" }, ...contracts])
  ).toBe(true);
});
