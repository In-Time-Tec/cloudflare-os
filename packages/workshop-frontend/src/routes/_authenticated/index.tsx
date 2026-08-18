import { useEffect } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import HomeDashboard from "../../components/AppShell/HomeDashboard";
import { openNewThread } from "../../components/AppShell/newThreadBus";
import { glanceRange } from "../../homeGreeting";
import { homePromptFromSearch } from "../../homePrompt";
import { agendaOptions } from "../../query/conversations";
import { modelsOptions } from "../../query/hooks";
import { useDocumentTitle } from "../../useDocumentTitle";

type HomeSearch = { prompt?: string };

export const Route = createFileRoute("/_authenticated/")({
  component: HomePage,
  validateSearch: (search: Record<string, unknown>): HomeSearch => ({
    prompt: homePromptFromSearch(search.prompt),
  }),
  loader: async ({ context }) => {
    const range = glanceRange();
    await Promise.all([
      context.queryClient.ensureQueryData({
        ...modelsOptions(context.session),
        revalidateIfStale: true,
      }),
      context.queryClient.ensureQueryData({
        ...agendaOptions(context.session, range.from, range.to),
        revalidateIfStale: true,
      }),
    ]);
  },
});

function HomePage() {
  return <HomePageContent prompt={Route.useSearch().prompt} />;
}

export function HomePageContent({ prompt }: HomeSearch) {
  useDocumentTitle("Home");
  const navigate = useNavigate();

  useEffect(() => {
    if (!prompt) return;
    openNewThread({ seed: prompt });
    navigate({ to: "/", search: {}, replace: true });
  }, [navigate, prompt]);

  return <HomeDashboard />;
}
