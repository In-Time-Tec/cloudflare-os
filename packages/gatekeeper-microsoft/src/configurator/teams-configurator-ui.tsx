import { Field, h, RadioCards, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { TeamsConfiguratorRpc, TeamsConfiguratorValues } from "./teams-configurator-types";

export default {
  initial: { mode: "all" },

  isReady() {
    return true;
  },

  initialValuesFromResourceUrl() {
    return { mode: "all" };
  },

  resourceUrl() {
    return "https://teams.microsoft.com/";
  },

  render({ values, setValues }) {
    return <Section>
      <Field label="Access scope">
        <RadioCards
          value={values.mode ?? "all"}
          options={[{
            value: "all",
            title: "Microsoft Teams",
            description: "Grants access to the connected account's Teams: read chats and channels, start chats, and post messages (each post needs your approval).",
          }]}
          onChange={() => setValues({ mode: "all" })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<TeamsConfiguratorRpc, TeamsConfiguratorValues>;
