import { SwaggerDoc } from "../types/swagger.js";

export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function jsonSchemaToTs(schema: any, name: string = "Root"): string {
  if (!schema) return "any";

  if (schema.$ref) {
    const parts = schema.$ref.split("/");
    return parts[parts.length - 1];
  }

  switch (schema.type) {
    case "string":
      if (schema.enum) {
        return schema.enum.map((v: string) => `'${v}'`).join(" | ");
      }
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "array":
      const itemType = jsonSchemaToTs(schema.items, "Item");
      return `${itemType}[]`;
    case "object":
      if (!schema.properties) return "Record<string, any>";
      const props = Object.entries(schema.properties)
        .map(([key, prop]: [string, any]) => {
          const isRequired = schema.required && schema.required.includes(key);
          const propType = jsonSchemaToTs(prop, capitalize(key));
          return `  ${key}${isRequired ? "" : "?"}: ${propType};`;
        })
        .join("\n");
      return `{\n${props}\n}`;
    default:
      return "any";
  }
}

/**
 * 获取$ref引用的schema名称
 */
function getRefName(ref: string): string {
  const parts = ref.split("/");
  return parts[parts.length - 1];
}

/**
 * 深度解析schema，完整展开$ref引用
 * 返回包含完整字段定义的结构化数据
 */
export function resolveSchema(schema: any, doc: SwaggerDoc, stack: string[] = []): any {
    if (!schema) return schema;
    
    // 处理$ref引用
    if (schema.$ref) {
      // 防止循环引用
      if (stack.includes(schema.$ref)) {
         return { 
           type: "object", 
           description: `[Circular Reference: ${schema.$ref}]`,
           $ref: schema.$ref,
           refName: getRefName(schema.$ref)
         };
      }
      
      // 解析引用路径
      const refPath = schema.$ref.replace("#/", "").split("/");
      let current: any = doc;
      for (const part of refPath) {
        current = current?.[part];
        if (!current) break;
      }
      
      // 如果找到了引用的schema
      if (current) {
        // 递归解析引用的schema
        const resolved = resolveSchema(current, doc, [...stack, schema.$ref]);
        // 合并原始schema的其他属性（如description等）
        const { $ref, ...rest } = schema;
        return { 
          ...resolved, 
          ...rest,
          $ref: schema.$ref,
          refName: getRefName(schema.$ref),
          resolved: true
        };
      }
      
      // 如果没找到，返回引用信息
      return { 
        $ref: schema.$ref,
        refName: getRefName(schema.$ref),
        notFound: true
      };
    }

    // 处理数组类型
    if (schema.type === "array" && schema.items) {
      const resolvedItems = resolveSchema(schema.items, doc, stack);
      return { 
        ...schema, 
        items: resolvedItems,
        itemType: resolvedItems.type || resolvedItems.refName
      };
    }

    // 处理对象类型 - 完整解析所有属性
    if (schema.properties) {
      const resolvedProps: Record<string, any> = {};
      const requiredFields = schema.required || [];
      
      for (const [key, prop] of Object.entries(schema.properties)) {
        const resolvedProp = resolveSchema(prop, doc, stack);
        // 添加字段元信息
        resolvedProps[key] = {
          ...resolvedProp,
          fieldName: key,
          required: requiredFields.includes(key),
          type: resolvedProp.type || resolvedProp.refName || "unknown"
        };
      }
      
      return { 
        ...schema, 
        properties: resolvedProps,
        requiredFields: requiredFields,
        fieldNames: Object.keys(resolvedProps)
      };
    }
    
    // 处理allOf组合
    if (schema.allOf) {
      const combined: any = { type: "object", properties: {}, required: [] };
      for (const subSchema of schema.allOf) {
         const resolved = resolveSchema(subSchema, doc, stack);
         if (resolved.properties) {
           Object.assign(combined.properties, resolved.properties);
         }
         if (resolved.required) {
           combined.required.push(...resolved.required);
         }
         // 合并其他属性
         const { properties, required, ...rest } = resolved;
         Object.assign(combined, rest);
      }
      combined.requiredFields = combined.required;
      combined.fieldNames = Object.keys(combined.properties);
      return combined;
    }

    // 处理oneOf
    if (schema.oneOf) {
      const resolvedOptions = schema.oneOf.map((s: any) => resolveSchema(s, doc, stack));
      return {
        ...schema,
        oneOf: resolvedOptions,
        type: "oneOf"
      };
    }

    // 基础类型直接返回
    return schema;
}

/**
 * 生成DTO的完整字段定义描述（用于AI理解）
 */
export function generateDtoDescription(schema: any, doc: SwaggerDoc, depth: number = 0): string {
  if (!schema) return "无定义";
  
  const indent = "  ".repeat(depth);
  
  // 处理$ref
  if (schema.$ref) {
    const refName = getRefName(schema.$ref);
    const refPath = schema.$ref.replace("#/", "").split("/");
    let current: any = doc;
    for (const part of refPath) {
      current = current?.[part];
      if (!current) break;
    }
    
    if (current) {
      return `[引用: ${refName}]\n${generateDtoDescription(current, doc, depth)}`;
    }
    return `[未找到引用: ${refName}]`;
  }
  
  // 处理对象
  if (schema.properties) {
    const required = schema.required || [];
    const lines: string[] = [];
    
    for (const [key, prop] of Object.entries(schema.properties) as [string, any][]) {
      const isRequired = required.includes(key);
      const propDesc = generateDtoDescription(prop, doc, depth + 1);
      const reqMark = isRequired ? " [必填]" : "";
      const descText = prop.description ? ` - ${prop.description}` : "";
      lines.push(`${indent}${key}${reqMark}${descText}:\n${propDesc}`);
    }
    
    return lines.join("\n") || `${indent}(空对象)`;
  }
  
  // 处理数组
  if (schema.type === "array" && schema.items) {
    const itemDesc = generateDtoDescription(schema.items, doc, depth + 1);
    return `${indent}数组类型:\n${itemDesc}`;
  }
  
  // 处理allOf
  if (schema.allOf) {
    const lines: string[] = [];
    for (const subSchema of schema.allOf) {
      lines.push(generateDtoDescription(subSchema, doc, depth));
    }
    return lines.join("\n");
  }
  
  // 基础类型
  const typeMap: Record<string, string> = {
    "string": "字符串",
    "number": "数字",
    "integer": "整数",
    "boolean": "布尔值",
    "object": "对象"
  };
  
  const typeDesc = typeMap[schema.type] || schema.type || "未知类型";
  const enumDesc = schema.enum ? ` (可选值: ${schema.enum.join(", ")})` : "";
  const formatDesc = schema.format ? ` (格式: ${schema.format})` : "";
  const defaultDesc = schema.default !== undefined ? ` (默认值: ${schema.default})` : "";
  
  return `${indent}${typeDesc}${enumDesc}${formatDesc}${defaultDesc}`;
}
