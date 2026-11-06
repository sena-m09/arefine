import { definePlugin, defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

const noLet = defineRule({
  meta: {
    type: "suggestion",
    docs: { description: "let を禁止し、再代入しない書き方に寄せる" },
    messages: {
      noLet:
        "let は使わず const にしてください。条件で値が変わるなら、関数に切り出して return するか三項演算子を使います。try/catch で代入しているなら、try/catch ごと関数に切り出します。",
    },
  },
  create(context) {
    return {
      VariableDeclaration(node) {
        if (node.kind === "let" || node.kind === "var") {
          context.report({ node, messageId: "noLet" });
        }
      },
    };
  },
});

const forOfOnly = defineRule({
  meta: {
    type: "suggestion",
    docs: { description: "ループは for...of だけにする" },
    messages: {
      forOfOnly:
        "添字の for・for...in・while は使わず、配列なら map・filter・flatMap、副作用を伴う繰り返しなら for...of を使ってください。",
    },
  },
  create(context) {
    const report = (node: ESTree.Node) => {
      context.report({ node, messageId: "forOfOnly" });
    };
    return {
      ForStatement: report,
      ForInStatement: report,
      WhileStatement: report,
      DoWhileStatement: report,
    };
  },
});

export default definePlugin({
  meta: { name: "local" },
  rules: { "no-let": noLet, "for-of-only": forOfOnly },
});
