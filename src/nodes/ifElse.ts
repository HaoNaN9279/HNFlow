// 条件分支节点：按 params.condition 对变量求值，结果写 true/false 双端口。

import type { INodeDefinition } from "../execution/types.js";

/** 比较操作符 */
type ConditionOp = "eq" | "ne" | "gt" | "gte" | "lt" | "lte";

/** 条件参数结构：variable 为 "scope:key" 路径，value 为期望值 */
interface IfElseCondition {
  readonly variable: string;
  readonly op: ConditionOp;
  readonly value: unknown;
}

/** ifElse 节点缺少或格式错误的 condition 参数 */
export class InvalidIfElseConditionError extends Error {
  readonly name = "InvalidIfElseConditionError";

  constructor(readonly condition: unknown) {
    super("invalid ifElse condition: expected { variable, op, value }");
  }
}

function isConditionOp(value: unknown): value is ConditionOp {
  return (
    value === "eq" ||
    value === "ne" ||
    value === "gt" ||
    value === "gte" ||
    value === "lt" ||
    value === "lte"
  );
}

/** 边界解析：从未知值解析 condition，非法返回 undefined */
function parseCondition(value: unknown): IfElseCondition | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    !("variable" in value) ||
    !("op" in value) ||
    !("value" in value)
  ) {
    return undefined;
  }
  const variable = value["variable"];
  const op = value["op"];
  const expected = value["value"];
  if (typeof variable !== "string" || !isConditionOp(op)) {
    return undefined;
  }
  return { variable, op, value: expected };
}

/** eq/ne：字符串与数字比较时按 Number 转换，转换失败为 false（跨类型恒不等） */
function eqValues(actual: unknown, expected: unknown): boolean {
  if (typeof actual === "string" && typeof expected === "number") {
    const numeric = Number(actual);
    return Number.isNaN(numeric) ? false : numeric === expected;
  }
  if (typeof actual === "number" && typeof expected === "string") {
    const numeric = Number(expected);
    return Number.isNaN(numeric) ? false : actual === numeric;
  }
  return actual === expected;
}

function assertNever(value: never): never {
  throw new Error(`unreachable condition op: ${JSON.stringify(value)}`);
}

function compareValues(actual: unknown, op: ConditionOp, expected: unknown): boolean {
  switch (op) {
    case "eq":
      return eqValues(actual, expected);
    case "ne":
      return !eqValues(actual, expected);
    case "gt":
      return Number(actual) > Number(expected);
    case "gte":
      return Number(actual) >= Number(expected);
    case "lt":
      return Number(actual) < Number(expected);
    case "lte":
      return Number(actual) <= Number(expected);
    default:
      return assertNever(op);
  }
}

export const ifElseNode: INodeDefinition = {
  type: "ifElse",
  name: "条件分支",
  inputs: [
    {
      id: "in",
      name: "value",
      type: "any",
      direction: "in",
      binding: "workflow:ifInput",
    },
  ],
  outputs: [
    {
      id: "true",
      name: "true",
      type: "boolean",
      direction: "out",
      binding: "workflow:ifTrue",
    },
    {
      id: "false",
      name: "false",
      type: "boolean",
      direction: "out",
      binding: "workflow:ifFalse",
    },
  ],
  async execute(ctx) {
    const condition = parseCondition(ctx.node.params["condition"]);
    if (condition === undefined) {
      throw new InvalidIfElseConditionError(ctx.node.params["condition"]);
    }
    const actual = ctx.getByPath(condition.variable);
    const result = compareValues(actual, condition.op, condition.value);
    return { true: result, false: !result };
  },
};
