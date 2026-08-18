import { Link } from "@tanstack/react-router";
import { PendingIcon, useLinkPending } from "./components/PendingIcon";
import { useKumoToastManager } from "@cloudflare/kumo";
import {
  Blueprint as BlueprintIcon,
  BookOpen,
  MagnifyingGlass,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { TemplatePublicInfo } from "@gadgets/workshop-shared/api";
import { VendorDescription } from "@gadgets/workshop-shared/gatekeeper";
import { useFeaturedTemplates, useGatekeeperVendors } from "./query/hooks";
import { BindingBadge, uniqueBindingBadges } from "./components/TemplateCard";
import { TemplatePreviewPlaceholder } from "./components/TemplatePreviewImage";
import ViewToggle from "./components/ViewToggle";
import PageChrome from "./components/AppShell/PageChrome";

type VendorMap = Map<string, VendorDescription>;

export default function TemplatesPage() {
  const toasts = useKumoToastManager();
  const toastsRef = useRef(toasts);
  toastsRef.current = toasts;

  const { data: featuredTemplates = [], isLoading: loading } = useFeaturedTemplates();
  const { data: rawVendors } = useGatekeeperVendors();
  const vendorDescriptions = useMemo(
    () => new Map<string, VendorDescription>((rawVendors ?? []).map((vendor) =>
      [vendor.id.toLowerCase(), vendor.description]) as [string, VendorDescription][]),
    [rawVendors])

  const [view, setView] = useState<"grid" | "list">(() => {
    if (typeof window === "undefined") return "grid";
    return localStorage.getItem("explore-view") === "list" ? "list" : "grid";
  });
  const [search, setSearch] = useState("");

  useEffect(() => {
    localStorage.setItem("explore-view", view);
  }, [view]);



  const q = search.trim().toLowerCase();
  const filtered = featuredTemplates.filter((b) => {
    if (!q) return true;
    return (
      b.metadata.title.toLowerCase().includes(q) ||
      (b.metadata.description ?? "").toLowerCase().includes(q)
    );
  });

  return (
    <PageChrome
      title="Explore"
      actions={<ViewToggle view={view} onChange={setView} />}
    >

      {/* Toolbar */}
      <div className="flex items-center justify-between gap-3 px-3 pb-3">
        <span className="text-[12px] font-medium uppercase tracking-[0.08em] text-kumo-inactive">
          Featured
        </span>
        <div className="relative sm:w-64">
          <MagnifyingGlass
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-kumo-inactive"
          />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search templates…"
            className="h-9 w-full rounded-lg border border-kumo-line bg-kumo-base pl-9 pr-4 text-[13px] tracking-[-0.25px] text-kumo-default placeholder:text-kumo-inactive transition-[border-color,box-shadow] duration-150 ease-out focus:border-kumo-ring focus:outline-none focus:ring-[3px] focus:ring-kumo-ring/15"
          />
        </div>
      </div>

      <div className="chat-panel min-h-0 flex-1 overflow-y-auto pb-8 pt-1">
        {loading ? (
          null
        ) : filtered.length === 0 ? (
          <EmptySection
            title={
              search
                ? "No templates match"
                : "No featured templates yet"
            }
            message={
              search
                ? "Try a different search term."
                : "Featured templates will appear here when they’re published. You can still create templates from your own workspaces."
            }
          />
        ) : view === "grid" ? (
          <div className="grid grid-cols-1 gap-4 px-3 sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map((template) => (
              <FeaturedTemplateCard
                key={template.id}
                template={template}
                vendorDescriptions={vendorDescriptions}
              />
            ))}
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {filtered.map((template) => (
              <FeaturedTemplateRow
                key={template.id}
                template={template}
                vendorDescriptions={vendorDescriptions}
              />
            ))}
          </div>
        )}
      </div>
    </PageChrome>
  );
}

function TemplateThumbnail({ template }: { template: TemplatePublicInfo }) {
  return (
    <div className="relative aspect-[16/9] w-full overflow-hidden border-b border-kumo-line bg-kumo-tint">
      {template.screenshotUrl ? (
        <img
          src={template.screenshotUrl}
          alt={`Screenshot of ${template.metadata.title}`}
          className="h-full w-full object-cover"
          loading="lazy"
        />
      ) : (
        <TemplatePreviewPlaceholder id={template.id} />
      )}
    </div>
  );
}

function FeaturedTemplateCard({
  template,
  vendorDescriptions,
}: {
  template: TemplatePublicInfo;
  vendorDescriptions: VendorMap;
}) {
  const badges = uniqueBindingBadges(template.metadata.bindings).slice(0, 2);
  const pending = useLinkPending({ to: "/template/$id", params: { id: template.id } });

  return (
    <div className="themed-card-hover-shadow press group relative flex cursor-pointer flex-col overflow-hidden rounded-xl border border-kumo-line bg-kumo-base text-left transition-[border-color,box-shadow] duration-150 ease-out hover:border-kumo-fill">
      <Link
        to="/template/$id"
        params={{ id: template.id }}
        aria-label={`Open featured template ${template.metadata.title}`}
        aria-busy={pending}
        className="absolute inset-0 z-10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kumo-brand"
      />

      <TemplateThumbnail template={template} />

      <div className="flex flex-1 items-start gap-2.5 px-3 py-2.5">
        <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-kumo-fill text-kumo-subtle">
          <PendingIcon pending={pending} size={16}>
            <BlueprintIcon size={15} weight="regular" />
          </PendingIcon>
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium leading-[18px] tracking-[-0.25px] text-kumo-default">
            {template.metadata.title}
          </p>
          <p
            className={`mt-0.5 line-clamp-1 text-[12px] leading-4 tracking-[-0.2px] ${
              template.metadata.description ? "text-kumo-subtle" : "italic text-kumo-inactive"
            }`}
          >
            {template.metadata.description || "No description"}
          </p>
          {badges.length > 0 && (
            <div className="relative z-20 mt-2 flex flex-wrap gap-1">
              {badges.map((badge) => (
                <BindingBadge
                  key={badge.vendorKey ?? badge.type}
                  badge={badge}
                  vendorDescriptions={vendorDescriptions}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function FeaturedTemplateRow({
  template,
  vendorDescriptions,
}: {
  template: TemplatePublicInfo;
  vendorDescriptions: VendorMap;
}) {
  const badges = uniqueBindingBadges(template.metadata.bindings).slice(0, 3);
  const pending = useLinkPending({ to: "/template/$id", params: { id: template.id } });

  return (
    <Link
      to="/template/$id"
      params={{ id: template.id }}
      aria-busy={pending}
      className="group flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 transition-colors duration-150 ease-out hover:bg-kumo-tint"
    >
      <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-kumo-fill text-kumo-subtle">
        <PendingIcon pending={pending} size={20}>
          <BlueprintIcon size={16} weight="regular" />
        </PendingIcon>
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium tracking-[-0.25px] text-kumo-default">
          {template.metadata.title}
        </p>
        <p
          className={`mt-0.5 line-clamp-1 text-[12px] leading-4 tracking-[-0.2px] ${
            template.metadata.description ? "text-kumo-subtle" : "italic text-kumo-inactive"
          }`}
        >
          {template.metadata.description || "No description"}
        </p>
      </div>
      {badges.length > 0 && (
        <div className="hidden shrink-0 items-center gap-1 lg:flex">
          {badges.map((badge) => (
            <BindingBadge
              key={badge.vendorKey ?? badge.type}
              badge={badge}
              vendorDescriptions={vendorDescriptions}
            />
          ))}
        </div>
      )}
    </Link>
  );
}

function EmptySection({ title, message }: { title: string; message: string }) {
  return (
    <div className="flex flex-col items-center gap-3 px-3 py-20 text-center">
      <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-kumo-fill text-kumo-subtle">
        <BookOpen size={18} />
      </div>
      <div>
        <p className="text-sm font-medium text-kumo-default">{title}</p>
        <p className="mx-auto mt-1 max-w-sm text-[13px] leading-[18px] text-kumo-subtle">
          {message}
        </p>
      </div>
    </div>
  );
}
