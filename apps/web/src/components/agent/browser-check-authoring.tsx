import type {
  TeachingBrowserAttachment,
  BrowserCheck,
  BrowserPredicate,
} from "@contingency/protocol";
import { Predicate, Schema } from "effect";

import { Button } from "@/components/ui/button";

const operators = [
  "exists",
  "equals",
  "contains",
  "gt",
  "gte",
  "lt",
  "lte",
] as const;
const rawOperators = ["exists", "equals", "contains"] as const;
/** Responses and JSON storage are typed values; cookies and raw storage are one root string. */
const readsFields = (check: BrowserCheck) =>
  check.kind === "response" || check.format === "json";
const asRawString = (check: BrowserCheck): BrowserCheck => ({
  ...check,
  demonstrated: false,
  expectation: {
    itemPath: [],
    predicates: check.expectation.predicates.map((predicate) => {
      const { expected, ...rest } = predicate;
      if (predicate.operator === "exists") {
        return { ...rest, path: [] };
      }
      return {
        ...rest,
        expected: Predicate.isString(expected) ? expected : "",
        operator: predicate.operator === "contains" ? "contains" : "equals",
        path: [],
      };
    }),
  },
});

const updateExpected = (
  input: HTMLInputElement,
  change: (expected: Exclude<BrowserPredicate["expected"], undefined>) => void
) => {
  try {
    const parsed = Schema.decodeUnknownSync(
      Schema.Union([Schema.String, Schema.Finite, Schema.Boolean, Schema.Null])
    )(JSON.parse(input.value));
    change(parsed);
    input.setCustomValidity("");
  } catch {
    input.setCustomValidity(
      'Enter a typed JSON value, for example "ready", 42, true, or null.'
    );
    input.reportValidity();
  }
};
const pathValue = (
  input: HTMLInputElement
): readonly (string | number)[] | undefined => {
  try {
    const path = Schema.decodeUnknownSync(
      Schema.Array(Schema.Union([Schema.String, Schema.Int]))
    )(JSON.parse(input.value));
    input.setCustomValidity("");
    return path;
  } catch {
    input.setCustomValidity(
      "Enter a path as an array of field names and indices."
    );
    input.reportValidity();
  }
};
const BrowserSourceEditor = ({
  check,
  update,
}: {
  readonly check: BrowserCheck;
  readonly update: (check: BrowserCheck) => void;
}) =>
  check.kind === "response" ? (
    <>
      <label>
        Method{" "}
        <input
          aria-label="Request method"
          value={check.request.method}
          onChange={(event) =>
            update({
              ...check,
              demonstrated: false,
              request: {
                ...check.request,
                method: event.target.value.toUpperCase(),
              },
            })
          }
        />
      </label>
      <label>
        Origin{" "}
        <input
          aria-label="Request origin"
          value={check.request.origin}
          onChange={(event) =>
            update({
              ...check,
              demonstrated: false,
              request: {
                ...check.request,
                origin: event.target.value,
              },
            })
          }
        />
      </label>
      <label>
        Path{" "}
        <input
          aria-label="Request path"
          value={check.request.path}
          onChange={(event) =>
            update({
              ...check,
              demonstrated: false,
              request: { ...check.request, path: event.target.value },
            })
          }
        />
      </label>
      <p>
        Use :name for one variable path segment. Query parameters are
        unconstrained unless listed below.
      </p>
      <label>
        Query constraints{" "}
        <input
          aria-label="Query constraints"
          defaultValue={JSON.stringify(check.request.query)}
          onBlur={(event) => {
            try {
              const query = Schema.decodeUnknownSync(
                Schema.Record(Schema.String, Schema.String)
              )(JSON.parse(event.currentTarget.value));
              update({
                ...check,
                demonstrated: false,
                request: { ...check.request, query },
              });
              event.currentTarget.setCustomValidity("");
            } catch {
              event.currentTarget.setCustomValidity(
                "Enter an object of query names and string values."
              );
              event.currentTarget.reportValidity();
            }
          }}
        />
      </label>
      <label>
        Response timing{" "}
        <select
          aria-label="Response timing"
          value={check.response}
          onChange={(event) =>
            update({
              ...check,
              response: event.target.value === "first" ? "first" : "matching",
            })
          }
        >
          <option value="matching">Wait for a matching response</option>
          <option value="first">Check the first response</option>
        </select>
      </label>
    </>
  ) : (
    <>
      <label>
        Name{" "}
        <input
          aria-label="Storage check name"
          value={check.name}
          onChange={(event) =>
            update({
              ...check,
              demonstrated: false,
              name: event.target.value,
            })
          }
        />
      </label>
      <label>
        Origin{" "}
        <input
          aria-label="Storage check origin"
          value={check.origin}
          onChange={(event) =>
            update({
              ...check,
              demonstrated: false,
              origin: event.target.value,
            })
          }
        />
      </label>
      <label>
        State{" "}
        <select
          aria-label="Storage check change"
          value={check.change}
          onChange={(event) =>
            update({
              ...check,
              change: Schema.decodeUnknownSync(
                Schema.Literals(["current", "changed", "created"])
              )(event.target.value),
            })
          }
        >
          <option value="created">Created after the action</option>
          <option value="changed">Changed after the action</option>
          <option value="current">Current state</option>
        </select>
      </label>
      {check.kind === "cookie" ? null : (
        <label>
          Storage format{" "}
          <select
            aria-label="Storage format"
            value={check.format ?? "raw"}
            onChange={(event) =>
              update(
                event.target.value === "json"
                  ? { ...check, demonstrated: false, format: "json" }
                  : asRawString({ ...check, format: "raw" })
              )
            }
          >
            <option value="raw">Raw string</option>
            <option value="json">JSON</option>
          </select>
        </label>
      )}
      {readsFields(check) ? (
        <p>
          JSON values over 64 KiB or that fail to parse are unreadable evidence.
        </p>
      ) : (
        <p>
          The stored value is checked as one string. Field paths do not apply.
        </p>
      )}
      <p>This declares an expectation. It never creates or changes storage.</p>
    </>
  );

export const BrowserAttachmentEditor = ({
  attachment,
  onChange,
  onRemove,
}: {
  readonly attachment: TeachingBrowserAttachment;
  readonly onChange: (attachment: TeachingBrowserAttachment) => void;
  readonly onRemove: () => void;
}) => {
  const check = attachment.requirement ?? attachment.candidate;
  const update = (next: BrowserCheck) =>
    onChange({
      ...attachment,
      candidate: next,
      label:
        next.kind === "response"
          ? `${next.request.method} ${next.request.path} · ${next.expectation.predicates[0]?.path.join(".") ?? "response"}`
          : `${next.kind} · ${next.name}`,
      requirement: attachment.requirement === undefined ? undefined : next,
    });
  const updatePredicate = (index: number, predicate: BrowserPredicate) =>
    update({
      ...check,
      demonstrated: false,
      expectation: {
        ...check.expectation,
        predicates: check.expectation.predicates.map((existing, position) =>
          position === index ? predicate : existing
        ),
      },
    });
  return (
    <details className="bg-muted rounded-lg px-3 py-2 text-xs">
      <summary className="cursor-pointer">
        {attachment.label} ·{" "}
        {attachment.requirement === undefined ? "Context" : "Must happen"}
      </summary>
      <div className="[&_input]:bg-background [&_select]:bg-background mt-2 grid max-h-80 gap-3 overflow-auto pr-1 [&_input]:min-w-0 [&_input]:rounded-md [&_input]:border [&_input]:px-2 [&_input]:py-1.5 [&_label]:grid [&_label]:gap-1 [&_select]:rounded-md [&_select]:border [&_select]:px-2 [&_select]:py-1.5">
        <label>
          Purpose{" "}
          <select
            aria-label={`Purpose for ${attachment.label}`}
            value={
              attachment.requirement === undefined ? "context" : "required"
            }
            onChange={(event) => {
              if (event.target.value === "context") {
                const { requirement: _removed, ...context } = attachment;
                onChange(context);
              } else {
                onChange({ ...attachment, requirement: check });
              }
            }}
          >
            <option value="context">Context for the agent</option>
            <option value="required">Must happen</option>
          </select>
        </label>
        {attachment.requirement === undefined ? (
          <p>Context does not constrain later Run success.</p>
        ) : (
          <>
            <label>
              When{" "}
              <input
                aria-label="Check timing"
                value={check.when}
                onChange={(event) =>
                  update({ ...check, when: event.target.value })
                }
              />
            </label>
            <label>
              Timeout in milliseconds{" "}
              <input
                aria-label="Check timeout"
                type="number"
                min={1}
                max={60_000}
                value={check.timeoutMs}
                onChange={(event) => {
                  const timeoutMs = event.target.valueAsNumber;
                  if (
                    Number.isInteger(timeoutMs) &&
                    timeoutMs > 0 &&
                    timeoutMs <= 60_000
                  ) {
                    update({ ...check, timeoutMs });
                  }
                }}
              />
            </label>
            <BrowserSourceEditor check={check} update={update} />
            {readsFields(check) ? (
              <>
                <label>
                  Array item path{" "}
                  <input
                    aria-label="Array item path"
                    defaultValue={JSON.stringify(check.expectation.itemPath)}
                    onBlur={(event) => {
                      const itemPath = pathValue(event.currentTarget);
                      if (itemPath !== undefined) {
                        update({
                          ...check,
                          demonstrated: false,
                          expectation: { ...check.expectation, itemPath },
                        });
                      }
                    }}
                  />
                </label>
                <p>
                  Use "*" for an item anywhere in an array, or a number for an
                  explicit index. All predicates below must match the same
                  selected item.
                </p>
              </>
            ) : null}
            {check.expectation.predicates.map((predicate, index) => (
              <fieldset
                className="grid gap-1 rounded border p-2"
                key={predicate.id ?? JSON.stringify(predicate.path)}
              >
                <legend>Field {index + 1}</legend>
                {readsFields(check) ? (
                  <label>
                    Full field path{" "}
                    <input
                      aria-label={`Field path ${index + 1}`}
                      defaultValue={JSON.stringify(predicate.path)}
                      onBlur={(event) => {
                        const path = pathValue(event.currentTarget);
                        if (path !== undefined) {
                          updatePredicate(index, { ...predicate, path });
                        }
                      }}
                    />
                  </label>
                ) : null}
                <label>
                  Comparison{" "}
                  <select
                    aria-label={`Comparison ${index + 1}`}
                    value={predicate.operator}
                    onChange={(event) => {
                      const operator = Schema.decodeUnknownSync(
                        Schema.Literals(operators)
                      )(event.target.value);
                      const { expected, ...withoutExpected } = predicate;
                      updatePredicate(
                        index,
                        operator === "exists"
                          ? { ...withoutExpected, operator }
                          : {
                              ...predicate,
                              expected: expected === undefined ? "" : expected,
                              operator,
                            }
                      );
                    }}
                  >
                    {(readsFields(check) ? operators : rawOperators).map(
                      (operator) => (
                        <option key={operator}>{operator}</option>
                      )
                    )}
                  </select>
                </label>
                {predicate.operator === "exists" ? null : (
                  <label>
                    Expected JSON value{" "}
                    <input
                      aria-label={`Expected value ${index + 1}`}
                      defaultValue={JSON.stringify(predicate.expected)}
                      onBlur={(event) =>
                        updateExpected(event.currentTarget, (expected) =>
                          updatePredicate(index, { ...predicate, expected })
                        )
                      }
                    />
                  </label>
                )}
                {check.expectation.predicates.length < 2 ? null : (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() =>
                      update({
                        ...check,
                        expectation: {
                          ...check.expectation,
                          predicates: check.expectation.predicates.filter(
                            (_, position) => position !== index
                          ),
                        },
                      })
                    }
                  >
                    Remove predicate
                  </Button>
                )}
              </fieldset>
            ))}
            <Button
              type="button"
              variant="ghost"
              disabled={check.expectation.predicates.length >= 20}
              onClick={() =>
                update({
                  ...check,
                  demonstrated: false,
                  expectation: {
                    ...check.expectation,
                    predicates: [
                      ...check.expectation.predicates,
                      { operator: "exists", path: [] },
                    ],
                  },
                })
              }
            >
              Add predicate to this item
            </Button>
            {check.demonstrated ? (
              <p>Observed during Teaching</p>
            ) : (
              <p>Not demonstrated. A fresh Dry Run must pass this check.</p>
            )}
          </>
        )}
        <Button type="button" variant="ghost" onClick={onRemove}>
          Remove attachment
        </Button>
      </div>
    </details>
  );
};
