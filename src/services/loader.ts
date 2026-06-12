import axios from "axios";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { SwaggerDoc } from "../types/swagger.js";

export class SwaggerLoader {
  private services: Map<string, string> = new Map();
  private cache: Map<string, SwaggerDoc> = new Map();
  private cacheTimestamp: Map<string, number> = new Map();
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes
  private authToken: string | null = null;
  private credentials: { user: string; pass: string; loginPath?: string } | null = null;
  private cookies: string | null = null;

  constructor() {
    this.parseArgs();
  }

  public setAuthToken(token: string) {
    this.authToken = token;
    console.error(`[Auth] Token cached successfully.`);
  }

  public getAuthToken(): string | null {
    return this.authToken;
  }

  public getCredentials() {
      return this.credentials;
  }

  public setCookies(cookieString: string) {
    this.cookies = cookieString;
    console.error(`[Cookie] Cookies configured successfully.`);
  }

  public getCookies(): string | null {
    return this.cookies;
  }

  private parseArgs() {
    const args = process.argv.slice(2);
    if (args.length === 0) {
      this.services.set("default", "http://localhost:8090/v3/api-docs");
      console.error("No arguments provided. Using default: http://localhost:8090/v3/api-docs");
      return;
    }

    for (const arg of args) {
      if (arg.startsWith("auth=")) {
          // Format: auth=user:pass OR auth=/login/path:user:pass
          const val = arg.substring(5);
          const parts = val.split(":");
          if (parts.length === 2) {
              this.credentials = { user: parts[0], pass: parts[1] };
              console.error(`[Auth] Credentials loaded for user: ${parts[0]}`);
          } else if (parts.length === 3) {
              this.credentials = { loginPath: parts[0], user: parts[1], pass: parts[2] };
              console.error(`[Auth] Auto-login configured. Path: ${parts[0]}, User: ${parts[1]}`);
          }
      } else if (arg.startsWith("cookie=")) {
          // Format: cookie=name1=value1;name2=value2
          const cookieValue = arg.substring(7);
          this.cookies = cookieValue;
          console.error(`[Cookie] Cookies loaded: ${cookieValue.substring(0, 20)}...`);
      } else if (arg.startsWith("http")) {
        // HTTP URL - register as default service
        this.services.set("default", arg);
        console.error(`Registered default service: ${arg}`);
      } else if (arg.includes("=")) {
        // name=url format (only if not an HTTP URL)
        const [name, url] = arg.split("=", 2);
        this.services.set(name, url);
        console.error(`Registered service '${name}': ${url}`);
      } else {
        console.error(`Ignoring invalid argument: ${arg}. Expected format: name=url or http://...`);
      }
    }
  }

  /**
   * 将 Swagger 2.0 文档标准化为 OpenAPI 3.0 格式
   */
  private normalizeSwaggerDoc(doc: any): any {
    if (!doc.swagger || doc.swagger !== "2.0") return doc;

    // 1. 复制 definitions → components.schemas
    if (doc.definitions) {
      if (!doc.components) doc.components = {};
      if (!doc.components.schemas) doc.components.schemas = {};
      for (const [name, schema] of Object.entries(doc.definitions)) {
        if (!doc.components.schemas[name]) {
          doc.components.schemas[name] = schema;
        }
      }
    }

    // 2. 构造 servers
    if (!doc.servers || doc.servers.length === 0) {
      const scheme = doc.schemes?.[0] || "https";
      const host = doc.host || "localhost";
      const basePath = doc.basePath || "";
      const url = `${scheme}://${host}${basePath}`;
      doc.servers = [{ url }];
    }

    // 3. 遍历处理每个 operation
    for (const pathObj of Object.values(doc.paths) as any[]) {
      for (const [method, operation] of Object.entries(pathObj) as any[]) {
        if (!operation || !operation.parameters) continue;

        const nonBodyParams: any[] = [];
        let bodyParam: any = null;

        for (const param of operation.parameters) {
          if (param.in === "body") {
            bodyParam = param;
          } else {
            // 4. 标准化非 body 参数：将顶层 type/format/items/enum 包装到 schema 下
            if (!param.schema && (param.type || param.format || param.items || param.enum)) {
              param.schema = {};
              if (param.type) param.schema.type = param.type;
              if (param.format) param.schema.format = param.format;
              if (param.items) param.schema.items = param.items;
              if (param.enum) param.schema.enum = param.enum;
              if (param.default !== undefined) param.schema.default = param.default;
            }
            nonBodyParams.push(param);
          }
        }

        // 过滤掉 body 参数
        operation.parameters = nonBodyParams;

        // 将 body 参数转为 requestBody（OpenAPI 3.0 格式）
        if (bodyParam && !operation.requestBody) {
          operation.requestBody = {
            required: bodyParam.required || false,
            content: {
              "application/json": {
                schema: bodyParam.schema || {}
              }
            }
          };
          if (bodyParam.description) {
            operation.requestBody.description = bodyParam.description;
          }
        }
      }
    }

    return doc;
  }

  public getServices(): Map<string, string> {
      return this.services;
  }

  public async getDoc(serviceName?: string, forceRefresh = false): Promise<{ doc: SwaggerDoc; name: string; baseUrl: string }> {
    let name = serviceName;
    if (!name) {
      if (this.services.size === 1) {
        name = this.services.keys().next().value;
      } else {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Multiple services configured. Please specify 'service_name'. Available: ${Array.from(this.services.keys()).join(", ")}`
        );
      }
    }

    if (!name || !this.services.has(name)) {
      throw new McpError(ErrorCode.InvalidParams, `Service '${name}' not found. Available: ${Array.from(this.services.keys()).join(", ")}`);
    }

    const docUrl = this.services.get(name)!;
    let doc: SwaggerDoc;

    // Check Cache with TTL
    const now = Date.now();
    const timestamp = this.cacheTimestamp.get(name) || 0;
    const isExpired = (now - timestamp) > this.CACHE_TTL;

    if (this.cache.has(name) && !forceRefresh && !isExpired) {
      doc = this.cache.get(name)!;
    } else {
      try {
        if (isExpired && this.cache.has(name)) {
            console.error(`[Cache] Doc for '${name}' expired. Refreshing...`);
        } else {
            console.error(`Fetching Swagger docs for '${name}' from ${docUrl}...`);
        }
        
        const headers: Record<string, string> = {};
        if (this.cookies) {
            headers['Cookie'] = this.cookies;
            console.error(`[Cookie] Injecting cookies into request`);
        }
        
        const response = await axios.get(docUrl, { headers });
        doc = this.normalizeSwaggerDoc(response.data);
        this.cache.set(name, doc);
        this.cacheTimestamp.set(name, now);
      } catch (error) {
        // Retry with 127.0.0.1 if localhost failed (Node 17+ IPv6 issue)
        if (docUrl.includes("localhost") && (error as any).code === "EACCES" || (error as any).code === "ECONNREFUSED") {
            try {
                const ipv4Url = docUrl.replace("localhost", "127.0.0.1");
                console.error(`Retrying with 127.0.0.1: ${ipv4Url}...`);
                
                const headers: Record<string, string> = {};
                if (this.cookies) {
                    headers['Cookie'] = this.cookies;
                }
                
                const response = await axios.get(ipv4Url, { headers });
                doc = this.normalizeSwaggerDoc(response.data);
                this.cache.set(name, doc);
                this.cacheTimestamp.set(name, now);
                // Update service url to avoid future errors
                this.services.set(name, ipv4Url);
            } catch (retryError) {
                 const msg = error instanceof Error ? error.message : String(error);
                 throw new McpError(
                  ErrorCode.InternalError,
                  `Failed to fetch Swagger docs for '${name}': ${msg}. Please ensure the service at ${docUrl} is running.`
                );
            }
        } else {
            const msg = error instanceof Error ? error.message : String(error);
            throw new McpError(
              ErrorCode.InternalError,
              `Failed to fetch Swagger docs for '${name}': ${msg}. Please ensure the service at ${docUrl} is running.`
            );
        }
      }
    }

    let baseUrl = "";
    if (doc.servers && doc.servers.length > 0) {
      baseUrl = doc.servers[0].url;
      if (!baseUrl.startsWith("http")) {
        const docUrlObj = new URL(docUrl);
        baseUrl = new URL(baseUrl, docUrlObj.origin).toString();
      }
    } else {
      const docUrlObj = new URL(docUrl);
      baseUrl = docUrlObj.origin;
    }
    if (baseUrl.endsWith("/")) baseUrl = baseUrl.slice(0, -1);

    return { doc, name, baseUrl };
  }
}
