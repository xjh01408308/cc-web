---
status: accepted
---

# @cc-web/shared 是纯源码包，无 build step

`@cc-web/shared` 协议包只发 TypeScript 源码（`as const` 常量对象 + 类型定义），不产出 `dist/` 或 JS。理由：三端运行时全部 TS 透传——relay/local 走 `tsx`，frontend 走 Vite，没有任何 restart 脚本用 `node dist/` 跑 local/relay（一律 `npx tsx ... src/index.ts`），所以 shared 不必产出可解析 JS，省掉 dev/prod build 同步摩擦。代价是 base tsconfig 需要 `allowImportingTsExtensions`，让各包 `tsc` 能跟上 shared 的 `.ts` 源。

考虑过的替代：给 shared 加 `tsc` build 指向 `dist/`（最"标准"的 workspace 包形态）。否决，因为它和"从不跑 `node dist/`"的现实矛盾，凭空多一层 build 同步。

若将来 local/relay 改走 `node dist/` 生产部署，再给 shared 补 tsc build + `exports` 指向 `dist/`。
