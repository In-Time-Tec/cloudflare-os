import { Field, h, RadioCards, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { CalendarConfiguratorRpc, CalendarConfiguratorValues } from "./calendar-configurator-types";

export default {
  initial: { mode: "all" },

  isReady() {
    return true;
  },

  initialValuesFromResourceUrl() {
    return { mode: "all" };
  },

  resourceUrl() {
    return "https://outlook.office.com/calendar/";
  },

  render({ values, setValues }) {
    return <Section>
      <Field label="Access scope">
        <RadioCards
          value={values.mode ?? "all"}
          options={[{
            value: "all",
            title: "Outlook Calendar",
            description: "Grants access to the connected account's calendar: read the agenda, check availability, and create, update, cancel, or respond to events (each change needs your approval).",
          }]}
          onChange={() => setValues({ mode: "all" })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<CalendarConfiguratorRpc, CalendarConfiguratorValues>;
