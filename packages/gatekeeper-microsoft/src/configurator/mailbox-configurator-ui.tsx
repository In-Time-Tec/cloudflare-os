import { Field, h, RadioCards, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { MailboxConfiguratorRpc, MailboxConfiguratorValues } from "./mailbox-configurator-types";

export default {
  initial: { mode: "all" },

  isReady() {
    return true;
  },

  initialValuesFromResourceUrl() {
    return { mode: "all" };
  },

  resourceUrl() {
    return "https://outlook.office.com/mail/";
  },

  render({ values, setValues }) {
    return <Section>
      <Field label="Access scope">
        <RadioCards
          value={values.mode ?? "all"}
          options={[{
            value: "all",
            title: "Outlook Mailbox",
            description: "Grants access to the whole connected mailbox: read and search messages, browse folders, read attachments, create drafts, and send email (each send needs your approval).",
          }]}
          onChange={() => setValues({ mode: "all" })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<MailboxConfiguratorRpc, MailboxConfiguratorValues>;
