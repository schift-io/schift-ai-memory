import {
  MCP_CLIENT_NAME,
  MCP_SERVER_VERSION,
  SchiftMcpConfig,
} from "./index.js";

export interface UpstreamBearerValidationResult {
  ok: boolean;
  status: number;
  error?: string;
}

export async function validateUpstreamBearer(
  config: SchiftMcpConfig,
): Promise<UpstreamBearerValidationResult> {
  const baseUrl = config.apiBaseUrl.replace(/\/+$/, "");
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/v1/buckets`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "X-Schift-Client": MCP_CLIENT_NAME,
        "X-Schift-MCP-Version": MCP_SERVER_VERSION,
      },
    });
  } catch (error) {
    return {
      ok: false,
      status: 502,
      error: `upstream_unreachable: ${String(error).slice(0, 120)}`,
    };
  }

  if (response.ok) {
    return { ok: true, status: response.status };
  }

  const detail = await response.text().catch(() => "");
  return {
    ok: false,
    status: response.status === 401 || response.status === 403 ? 401 : 502,
    error: detail.slice(0, 200) || `upstream_${response.status}`,
  };
}
