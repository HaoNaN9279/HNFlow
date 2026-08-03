// 图变换 API：子图打包（packageSubgraph）/ 展开（expandSubgraph）。
// 打包把一段节点折叠为 subworkflow 节点（自动边界端口、自动 end、依赖快照）；
// 展开反向还原，删除自动补的 __end 节点。
export { packageSubgraph } from "./package.js";
export { expandSubgraph } from "./expand.js";
export {
  InvalidSubgraphSelectionError,
  type PackageSubgraphResult,
} from "./shared.js";
