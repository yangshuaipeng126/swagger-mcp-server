# Swagger MCP Server

将任意 Swagger/OpenAPI 文档转化为 AI 可调用的 MCP 工具集，支持文档查询、接口调试、cURL 生成和 DTO 字段探查。

兼容 **Swagger 2.0** 和 **OpenAPI 3.0**，自动标准化文档格式。

---

## 快速开始

### 安装与构建

```bash
npm install
npm run build
```

### 配置 MCP

编辑 MCP 配置文件（Claude Desktop、Cursor、Windsurf 等）：

```json
{
  "mcpServers": {
    "swagger": {
      "command": "node",
      "args": [
        "/path/to/swagger-mcp-server/build/index.js",
        "http://your-api-host/v2/api-docs"
      ]
    }
  }
}
```

### 配置参数

| 格式 | 示例 | 说明 |
|------|------|------|
| Swagger 文档地址 | `http://localhost:8090/v3/api-docs` | 直接填入 URL，注册为 `default` 服务 |
| 命名服务 | `order=http://localhost:8091/v3/api-docs` | `name=url` 格式，支持多服务 |
| Cookie 认证 | `cookie=token=abc123` | 注入 Cookie，适用于已有 Token 的场景 |
| 账号密码 | `auth=admin:123456` | 预设凭证，接口返回 401 时会自动提示 AI 登录 |
| 自动登录 | `auth=/auth/login:admin:123456` | 指定登录路径，401 时自动完成登录并重试 |

多参数组合示例：

```json
{
  "mcpServers": {
    "swagger": {
      "command": "node",
      "args": [
        "/path/to/swagger-mcp-server/build/index.js",
        "user=http://api.example.com/v2/api-docs",
        "order=http://api.example.com/order/v3/api-docs",
        "cookie=token=abc123;uid=456",
        "auth=/api/login:admin:123456"
      ]
    }
  }
}
```

---

## 工具列表

| 工具 | 说明 | 必填参数 |
|------|------|----------|
| `list_services` | 列出所有已配置的服务 | — |
| `refresh_docs` | 强制刷新文档缓存 | `service_name`（可选） |
| `list_endpoints` | 列出所有接口摘要 | `service_name`（可选） |
| `search_apis` | 按关键词搜索接口（加权匹配） | `query` |
| `get_endpoint_details` | 获取接口完整定义（参数、请求体、响应） | `path`, `method` |
| `get_dto_definition` | 获取 DTO 的完整字段定义（含嵌套展开） | `dto_name` |
| `list_all_dtos` | 列出所有可用 DTO 及其字段摘要 | — |
| `debug_endpoint` | 发送真实 HTTP 请求调试接口 | `path`, `method` |
| `generate_curl` | 生成 cURL 命令 | `path`, `method` |

---

## 工具详解

### `search_apis` — 智能搜索

支持多关键词加权匹配：路径匹配权重最高，其次是摘要，最后是描述。按评分降序排列，返回 Top 20。

```
> 搜索 "创建用户"
→ POST /user/create  (路径命中 + 摘要命中 = 高分)
→ POST /account/add  (仅描述命中 = 低分)
```

### `get_endpoint_details` — 接口详情

返回接口的完整结构：

- **parameters** — 路径参数、查询参数的名称、类型、是否必填、描述
- **requestBody** — 请求体的完整 JSON Schema
- **requestBodyFields** — 请求体字段的人类可读描述（含嵌套结构）
- **responses** — 各状态码的响应结构及字段描述

### `get_dto_definition` — DTO 字段探查

递归展开 DTO 的所有字段，包括嵌套对象和数组。输出：

- **description** — 结构化字段树（含必填标记、类型、注释）
- **typescriptDefinition** — 自动生成的 TypeScript 接口定义
- **rawSchema** — 完整的解析后 JSON Schema

### `debug_endpoint` — 接口调试

发送真实 HTTP 请求，支持：

- **自动 Token 注入** — 如果之前登录过，自动携带缓存的 Token
- **自动 Cookie 注入** — 使用配置中的 Cookie
- **参数自动补齐** — POST/PUT/PATCH 请求的必填字段会用默认值填充，避免 400
- **401 自动登录** — 如果配置了 `auth=/path:user:pass`，遇到 401 会自动登录并重试；如果仅配置了 `auth=user:pass`，会提示 AI 调用登录接口
- **Token 自动捕获** — 从响应的 `token`/`accessToken`/`access_token` 或 `Authorization` 头自动缓存 Token
- **localhost 纠错** — Node 17+ 环境下自动将 `localhost` 切换为 `127.0.0.1`

### `generate_curl` — cURL 生成

根据接口定义生成标准的 cURL 命令，自动拼接 Base URL、Headers 和 Body。

---

## DTO 探查工作流

推荐的两步流程，快速了解接口的请求/响应结构：

```
1. list_all_dtos           → 浏览可用的 DTO 列表，找到目标
2. get_dto_definition      → 展开某个 DTO 的完整字段定义
3. get_endpoint_details    → 查看接口使用的具体 DTO 及参数
```

---

## 架构与缓存

- **文档缓存** — 首次加载后缓存 5 分钟，过期自动刷新，`refresh_docs` 可强制刷新
- **Token 缓存** — 登录后 Token 常驻内存，后续请求自动注入
- **Swagger 2.0 兼容** — 获取文档时自动标准化为 OpenAPI 3.0 格式（`definitions` → `components.schemas`、`in: body` → `requestBody`、`host+basePath` → `servers`）

---

## 项目结构

```
src/
├── index.ts              # 服务入口
├── services/
│   └── loader.ts         # 文档加载、缓存、标准化、认证管理
├── tools/
│   └── index.ts          # MCP 工具实现
├── utils/
│   └── schema.ts         # $ref 解析、JSON Schema → TS 类型生成
└── types/
    └── swagger.ts        # 类型定义
```

---

## 常见问题

**Q: 本地服务连接报错 `ECONNREFUSED ::1:8090`？**

A: 已内置自动纠错，会切换到 `127.0.0.1` 重试，无需手动处理。

**Q: `list_all_dtos` 返回空列表？**

A: 可能你的 Swagger 是 2.0 版本（`/v2/api-docs`）。V2 已支持 Swagger 2.0 的 `definitions` 自动兼容，确保使用最新版本。

**Q: 登录接口的 Token 不在 `data.token` 中？**

A: 支持自动识别 `token`、`accessToken`、`access_token` 及 `Authorization` 响应头。如果结构特殊，可修改 `src/tools/index.ts` 中 `debug_endpoint` 的 Token 提取逻辑。

**Q: 请求一直返回参数错误？**

A: 使用 `get_endpoint_details` 确认参数结构，或直接用 `debug_endpoint` 让 MCP 自动补齐必填字段。
