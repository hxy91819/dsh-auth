# 代码健康度治理

本文档面向贡献者，定义 `dsh-auth` 的静态质量门禁。公共 `README.md` 继续只说明软件用途与运维安装方式。

## 执行入口

```sh
corepack pnpm run check:code-health  # 阻断型静态检查
corepack pnpm run report:code-health # 生成生产与开发辅助范围的 JSON 报告
corepack pnpm run check              # 静态检查、类型检查、测试、构建和包结构检查
```

CI 的 `Code Health` job 独立运行阻断检查，并将 `.tmp/code-health/` 中的生产结果及测试/脚本报告保留 90 天。分析器无法执行、配置无效或发现 ESLint 正确性错误时检查失败；测试和脚本中的健康度规则仅产生 warning。

## 固定工具版本

| 工具 | 版本 | 用途 |
|---|---:|---|
| ESLint | 9.33.0 | 正确性 lint、行数、语句数和圈复杂度 |
| eslint-plugin-sonarjs | 4.2.0 | 认知复杂度 |
| jscpd | 5.0.15 | 重复代码 |
| dependency-cruiser | 18.2.0 | 循环、解析、依赖声明和架构边界 |
| Knip | 6.32.2 | 死文件、未用依赖和未用内部导出 |
| publint | 0.3.23 | npm 发布包结构 |

升级分析器必须单独审阅配置语义和输出变化，并与代码修改一同通过完整 `pnpm run check`。

## 阈值

有效行数不计空行和纯注释。函数范围包括普通函数、方法和箭头函数。

| 指标 | `src/`（error） | `tests/`、`scripts/`（warning） |
|---|---:|---:|
| 文件有效行数 | 800 | 1200 |
| 函数有效行数 | 120 | 180 |
| 函数语句数 | 80 | 120 |
| 认知复杂度 | 30 | 45 |
| 圈复杂度 | 25 | 40 |
| 重复代码 | ≥120 tokens 且 ≥5 行即失败 | ≥180 tokens 且 ≥8 行时报告 |

生产重复代码使用 jscpd `threshold=0`，因此任何达到生产最小块大小的 clone group 都会失败。测试和脚本报告不以重复比例阻断。

## 架构边界

dependency-cruiser 对 `src/` 强制以下约束：

- 禁止循环 import、无法解析的 import 和未声明包依赖。
- 浏览器入口 `client.tsx`、`browser-bootstrap.ts` 不得依赖 Node 内置模块、服务端或安装器层。
- 安装器不得反向依赖 HTTP、浏览器、配置、Cookie、加密、会话或 Cordis 注册层；安装器只能由 CLI 进入。
- 生产代码不得依赖 `tests/` 或 `scripts/`。

新增跨层依赖时应先调整职责边界；不能通过宽泛路径忽略绕开约束。

## 静态入口与例外

Knip 明确登记所有动态或环境入口：

- `src/index.ts`、`src/cli.ts` 是包与 CLI 入口；`./client` 由 `package.json` 的 exports 自动识别。
- `@deepseek-ai/dsh` 的二进制由真实 E2E 通过绝对路径动态解析。
- 系统 `caddy`/`nginx` 仅用于隔离检查和遗留模板校验，不是 npm 依赖。

`./client` 采用 DSH 官方自定义模块加载器格式，publint 仍负责阻断包结构错误；不启用与该格式不兼容的 `arethetypeswrong` 硬门禁。

禁止整文件关闭门禁。未来确有必要的例外必须精确到规则和符号，并在代码附近记录设计理由、批准人和到期条件。
