import type { ReactNode } from "react";
import { createContext, useContext } from "react";

import * as rpc from "@/lib/rpc";

export type RpcDependencies = typeof rpc;

const RpcDependenciesContext = createContext<RpcDependencies>(rpc);

export const RpcDependenciesProvider = ({
  children,
  overrides,
}: {
  readonly children: ReactNode;
  readonly overrides: Partial<RpcDependencies>;
}) => (
  <RpcDependenciesContext value={{ ...rpc, ...overrides }}>
    {children}
  </RpcDependenciesContext>
);

export const useRpcDependencies = (): RpcDependencies =>
  useContext(RpcDependenciesContext);
