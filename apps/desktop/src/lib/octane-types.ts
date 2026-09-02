/** @jsxImportSource octane */

import type { ComponentBody, OctaneNode } from "octane";
import type { JSX as OctaneJSX } from "octane/jsx-runtime";

export type Renderable = OctaneNode;
export type OctaneComponent<P = unknown> = ComponentBody<P>;

export type PropsOf<T> = T extends (...args: infer Args) => unknown
  ? Args[0]
  : T extends keyof OctaneJSX.IntrinsicElements
    ? OctaneJSX.IntrinsicElements[T]
    : never;

export type DivProps = PropsOf<"div">;
export type SpanProps = PropsOf<"span">;
export type TableProps = PropsOf<"table">;
export type TableSectionProps = PropsOf<"thead">;
export type TableCellProps = PropsOf<"th">;
export type TableDataCellProps = PropsOf<"td">;
