import { config } from "./config.js";

export interface SearchResult {
  id: string;
  title?: string;
  shortDescription?: string;
  author: string;
  authorData?: {
    fullname?: string;
  };
  likes?: number;
  sdk?: string;
  semanticRelevancyScore?: number;
}

const RESULTS_TO_RETURN = 10;

export class SemanticSearch {
  private readonly apiUrl: string;

  constructor(apiUrl?: string) {
    this.apiUrl = apiUrl || "https://huggingface.co/api/spaces/semantic-search";
  }

  async search(
    query: string,
    limit: number = RESULTS_TO_RETURN
  ): Promise<SearchResult[]> {
    try {
      if (!query) {
        return [];
      }

      const url =
        `${this.apiUrl}?` + new URLSearchParams({ q: query, sdk: "gradio" });

      const headers: HeadersInit = {
        "Content-Type": "application/json",
      };

      if (config.hfToken) {
        headers["Authorization"] = `Bearer ${config.hfToken}`;
      }

      const response = await fetch(url, headers);

      if (!response.ok) {
        throw new Error(
          `Search request failed: ${response.status} ${response.statusText}`
        );
      }

      const results = (await response.json()) as SearchResult[];

      // Filter for gradio results and limit by count
      return results
        .filter((result) => result.sdk === "gradio")
        .slice(0, limit);
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to search for spaces: ${error.message}`);
      }
      throw error;
    }
  }

  formatSearchResults(results: SearchResult[]): string {
    if (results.length === 0) {
      return "No matching Hugging Face Spaces found. Try a different query.";
    }

    let markdown = "# Search Results for Hugging Face Spaces\n\n";
    markdown += "| Space | Description | Author | ID |\n";
    markdown += "|-------|-------------|--------|----|\n";

    for (const result of results) {
      const title = result.title || "Untitled";
      const description = result.shortDescription || "No description";
      const author = result.authorData?.fullname || result.author || "Unknown";
      const id = result.id || "";

      markdown +=
        `| [${escapeMarkdown(title)}](https://huggingface.co/api/spaces/${id}) ` +
        `| ${escapeMarkdown(description)} ` +
        `| ${escapeMarkdown(author)} ` +
        `| \`${escapeMarkdown(id)}\` |\n`;
    }

    markdown +=
      "\nTo use one of these spaces, you can provide the ID in the format: `owner/space` or `owner/space/endpoint`";

    return markdown;
  }
}

// Helper function to escape markdown special characters in table cells
function escapeMarkdown(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
