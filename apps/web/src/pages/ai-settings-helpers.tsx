import { RefreshCw } from "lucide-react";


export const PROVIDERS = [
  { value: "openai", label: "OpenAI", local: false },
  { value: "anthropic", label: "Anthropic Claude", local: false },
  { value: "gemini", label: "Google Gemini", local: false },
  { value: "xai", label: "xAI Grok", local: false },
  { value: "openrouter", label: "OpenRouter", local: false },
  { value: "ollama", label: "Ollama", local: true },
] as const;

export const TEXT_TASKS = ["assistant", "documents", "imports", "search"] as const;

export const TASK_LABELS: Record<string, string> = {
  assistant: "Assistant",
  imports: "Smart imports",
  documents: "Document interpretation",
  search: "Natural-language search",
  vision: "Image recognition",
  transcription: "Voice transcription",
};

export const CAPABILITY_LABELS: Record<string, string> = {
  text: "Text",
  vision: "Vision",
  structured: "Structured JSON",
  tools: "Tool calling",
  audio: "Audio input",
  image: "Image generation",
};

export interface ProviderDraft {
  provider: string;
  display_name: string;
  base_url: string;
  default_model: string;
  api_key: string;
  enabled: boolean;
  cloud_consent: boolean;
}

export const emptyDraft: ProviderDraft = {
  provider: "openai",
  display_name: "OpenAI",
  base_url: "https://api.openai.com/v1",
  default_model: "",
  api_key: "",
  enabled: true,
  cloud_consent: false,
};

export function providerLabel(value: string) {
  return PROVIDERS.find((provider) => provider.value === value)?.label ?? value;
}

export function endpointScope(provider: string, baseUrl: string): "local" | "private" | "remote" {
  if (provider !== "ollama") return "remote";
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    if (
      !host ||
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host === "host.docker.internal" ||
      host === "host.containers.internal" ||
      host.endsWith(".localhost") ||
      /^127\./.test(host)
    ) {
      return "local";
    }
    if (
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
      /^169\.254\./.test(host) ||
      /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host) ||
      host.endsWith(".local") ||
      host.endsWith(".internal") ||
      host.endsWith(".lan") ||
      host.endsWith(".home") ||
      host.endsWith(".ts.net")
    ) {
      return "private";
    }
    if (!host.includes(".")) return "local";
    return "remote";
  } catch {
    return "remote";
  }
}

export function scopeLabel(scope: "local" | "private" | "remote") {
  return scope === "local" ? "Local" : scope === "private" ? "Private network" : "Remote/cloud";
}

export function SparklesIcon() {
  return <RefreshCw className="size-4 text-brass" />;
}
