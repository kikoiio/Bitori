/** 首次启动写入 ~/.bitori/config.yaml 的默认模板；这是该文件内容的唯一来源，仓库不再保留副本。 */
export const defaultUserConfigYaml = `# 连接参数只写在同目录 .env。protocol 是接口方言，不是供应商名称。
# 新增 Provider 直接在 .env 加一组 <前缀>_API_KEY / _BASE_URL / _MODEL 即可自动识别，不用改本文件。
# OpenAI 兼容网关用 openai-chat；Qoder PAT（pt-）用 qoder（填 <前缀>_PROTOCOL=qoder，base_url 填
# https://api.qoder.com.cn 或 https://api.qoder.com，model 可用展示名或官方 id）。
profiles:
  - name: default
    protocol: openai-chat
    model: \${LLM_MODEL}
    base_url: \${LLM_BASE_URL}
    api_key: \${LLM_API_KEY}

# 也可以在这里显式固定多个 profile；model/base_url 支持 \${ENV_NAME} 引用。
#  - name: qoder
#    protocol: qoder
#    model: \${QODER_MODEL}
#    base_url: \${QODER_BASE_URL}
#    api_key: \${QODER_API_KEY}

# 可选 MCP：只在准备好真实服务和凭据后取消注释并替换占位值。
# MCP 配置中的变量在启动时展开，缺失即报错。
# mcp_servers:
#   remote-search:
#     transport: http
#     url: https://your-server.example/mcp
#     headers:
#       Authorization: Bearer \${MCP_REMOTE_TOKEN}

# 可选：SubAgent 逻辑模型名 -> profile 名；未命中时回退当前 profile。
# models:
#   helper: default
`;

/** 首次启动写入 ~/.bitori/.env；必须与仓库根目录 .env.example 逐字节一致（有测试断言）。用户在此填写密钥与连接参数。 */
export const defaultUserEnv = `# Bitori 密钥文件：一个 Provider = 一组同前缀变量，填完即生效，不需要改 config.yaml。
# 前缀全大写（字母开头），profile 名自动取前缀小写。示例——OpenRouter：
#   OPENROUTER_API_KEY=sk-or-v1-...
#   OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
#   OPENROUTER_MODEL=deepseek/deepseek-chat
# 示例——Qoder（需显式协议与区域端点）：
#   QODER_API_KEY=pt-...
#   QODER_BASE_URL=https://api.qoder.com.cn
#   QODER_MODEL=DeepSeek-Flash
#   QODER_PROTOCOL=qoder
# 可选 <前缀>_PROTOCOL：openai-chat（默认）| openai-responses | anthropic | qoder。
# anthropic / OpenAI 兼容省略 BASE_URL 时用官方默认端点；qoder 必须提供。
# 不完整的变量组会被跳过并在 bitori doctor 中列明缺哪一项；config.yaml 显式定义的 profile 优先。

# default profile（config.yaml 模板）使用的连接参数；不使用它可以留空：
# 协议（anthropic / openai-chat / openai-responses / qoder）在 config.yaml 里写死；
# Anthropic 兼容网关的 base_url 填接口根即可，SDK 自己拼 /v1/messages。
LLM_API_KEY=
LLM_BASE_URL=
LLM_MODEL=
`;
