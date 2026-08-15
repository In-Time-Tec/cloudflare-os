import { Field, h, RadioCards, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { FilesConfiguratorRpc, FilesConfiguratorValues } from "./files-configurator-types";

export default {
  initial: { mode: "all" },

  isReady() {
    return true;
  },

  initialValuesFromResourceUrl() {
    return { mode: "all" };
  },

  resourceUrl() {
    return "https://onedrive.office.com/";
  },

  render({ values, setValues }) {
    return <Section>
      <Field label="Access scope">
        <RadioCards
          value={values.mode ?? "all"}
          options={[{
            value: "all",
            title: "OneDrive & SharePoint Files",
            description: "Grants access to the connected account's OneDrive and visible SharePoint libraries: browse, search, and read files, and create, upload, replace, or delete them (each change needs your approval).",
          }]}
          onChange={() => setValues({ mode: "all" })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<FilesConfiguratorRpc, FilesConfiguratorValues>;
