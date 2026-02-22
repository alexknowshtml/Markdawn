import React, { useEffect, useMemo, useState } from "react";
import { createReactBlockSpec } from "@blocknote/react";

type EmbedType = "youtube" | "twitter" | "generic" | "invalid";

const extractYouTubeId = (url: URL) => {
  const hostname = url.hostname.replace(/^www\./, "");

  if (hostname === "youtu.be") {
    return url.pathname.replace("/", "");
  }

  if (hostname.endsWith("youtube.com")) {
    if (url.pathname === "/watch") {
      return url.searchParams.get("v");
    }

    if (url.pathname.startsWith("/embed/")) {
      return url.pathname.replace("/embed/", "");
    }

    if (url.pathname.startsWith("/shorts/")) {
      return url.pathname.replace("/shorts/", "");
    }
  }

  return null;
};

const getEmbedType = (rawUrl: string) => {
  try {
    const parsedUrl = new URL(rawUrl);
    const hostname = parsedUrl.hostname.replace(/^www\./, "");
    const youtubeId = extractYouTubeId(parsedUrl);

    if (youtubeId) {
      return {
        type: "youtube" as const,
        embedUrl: `https://www.youtube.com/embed/${youtubeId}`,
        displayUrl: parsedUrl.toString(),
      };
    }

    if (hostname.endsWith("twitter.com") || hostname === "x.com" || hostname.endsWith("x.com")) {
      return {
        type: "twitter" as const,
        displayUrl: parsedUrl.toString(),
      };
    }

    return {
      type: "generic" as const,
      displayUrl: parsedUrl.toString(),
    };
  } catch {
    return {
      type: "invalid" as const,
      displayUrl: rawUrl,
    };
  }
};

export const embedBlockSpec = createReactBlockSpec(
  {
    type: "embed",
    propSchema: {
      url: {
        default: "",
      },
    },
    content: "none",
  },
  {
    render: ({ block, editor }) => {
      const [inputValue, setInputValue] = useState(block.props.url);

      useEffect(() => {
        setInputValue(block.props.url);
      }, [block.props.url]);

      const embedData = useMemo(() => {
        if (!block.props.url) {
          return null;
        }

        return getEmbedType(block.props.url);
      }, [block.props.url]);

      const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const nextUrl = inputValue.trim();
        if (!nextUrl) {
          return;
        }
        editor.updateBlock(block.id, { props: { url: nextUrl } });
      };

      const handleRemove = () => {
        editor.updateBlock(block.id, { props: { url: "" } });
        setInputValue("");
      };

      return (
        <div className="w-full rounded-lg border border-zinc-200 bg-white/60 p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/40">
          {!block.props.url && (
            <form className="flex flex-col gap-3" onSubmit={handleSubmit}>
              <label className="text-sm font-medium text-zinc-700 dark:text-zinc-200" htmlFor={`embed-url-${block.id}`}>
                Embed URL
              </label>
              <input
                id={`embed-url-${block.id}`}
                className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 shadow-sm outline-none transition focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                placeholder="Embed URL"
                type="url"
                value={inputValue}
                onChange={(event) => setInputValue(event.target.value)}
              />
              <div className="flex items-center gap-2">
                <button
                  className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
                  type="submit"
                >
                  Embed
                </button>
              </div>
            </form>
          )}

          {block.props.url && embedData && (
            <div className="space-y-3">
              {embedData.type === "youtube" && (
                <div className="aspect-video w-full overflow-hidden rounded-md border border-zinc-200 bg-black/80 dark:border-zinc-800">
                  <iframe
                    className="h-full w-full"
                    src={embedData.embedUrl}
                    title="YouTube embed"
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                    allowFullScreen
                  />
                </div>
              )}

              {embedData.type === "twitter" && (
                <blockquote className="rounded-md border border-zinc-200 bg-white/80 p-4 text-sm text-zinc-700 shadow-sm dark:border-zinc-800 dark:bg-zinc-950/60 dark:text-zinc-200">
                  <p className="mb-2 text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Embedded post</p>
                  <a
                    className="block break-all text-sm font-medium text-blue-600 transition hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
                    href={embedData.displayUrl}
                    rel="noreferrer"
                    target="_blank"
                  >
                    {embedData.displayUrl}
                  </a>
                </blockquote>
              )}

              {embedData.type === "generic" && (
                <div className="aspect-video w-full overflow-hidden rounded-md border border-zinc-200 bg-black/80 dark:border-zinc-800">
                  <iframe
                    className="h-full w-full"
                    src={embedData.displayUrl}
                    title="Embedded content"
                    sandbox="allow-same-origin allow-scripts allow-popups allow-forms"
                  />
                </div>
              )}

              {embedData.type === "invalid" && (
                <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200">
                  Invalid URL. Please remove and try again.
                </div>
              )}

              <button
                className="text-sm font-medium text-zinc-500 transition hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
                type="button"
                onClick={handleRemove}
              >
                Remove
              </button>
            </div>
          )}
        </div>
      );
    },
  }
)();
