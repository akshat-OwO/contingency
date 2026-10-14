import {
  createFileRoute,
  useNavigate,
  useSearch,
} from "@tanstack/react-router";
import { Option, Schema } from "effect";

import {
  PROTOTYPE_STATES,
  PROTOTYPE_VARIANTS,
} from "@/prototypes/android/fixtures";
import { AndroidPrototypePage } from "@/prototypes/android/prototype-page";

/*
  #479 prototypes. Delete this route and `src/prototypes/android` to remove
  them; nothing in the shipped Workspace depends on either.
*/
const PrototypeSearch = Schema.Struct({
  chrome: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  state: Schema.optional(Schema.Literals(PROTOTYPE_STATES)),
  variant: Schema.optional(Schema.Literals(PROTOTYPE_VARIANTS)),
});

const AndroidPrototypeRoute = () => {
  const { chrome, state, variant } = useSearch({ from: "/prototypes/android" });
  const navigate = useNavigate({ from: "/prototypes/android" });
  return (
    <AndroidPrototypePage
      chrome={String(chrome) !== "0"}
      onChange={(nextVariant, nextState) => {
        navigate({
          search: { chrome, state: nextState, variant: nextVariant },
        });
      }}
      state={state ?? "teaching"}
      variant={variant ?? "direct"}
    />
  );
};

export const Route = createFileRoute("/prototypes/android")({
  component: AndroidPrototypeRoute,
  validateSearch: <Search,>(search: Search): typeof PrototypeSearch.Type =>
    Schema.decodeUnknownOption(PrototypeSearch)(search).pipe(
      Option.getOrElse(() => ({}))
    ),
});
