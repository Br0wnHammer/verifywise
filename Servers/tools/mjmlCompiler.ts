import mjml2html from "mjml";

export const compileMjmlToHtml = async (
  mjmlTemplate: string,
  data: Record<string, string>,
): Promise<string> => {
  // One pass with a replacer function: values are inserted literally, so a
  // "$&" or "$'" in user text is not read as a replacement pattern, and a
  // "{{key}}" inside a value is not substituted by a later key.
  const compiledTemplate = mjmlTemplate.replace(/{{(\w+)}}/g, (placeholder, key: string) =>
    Object.prototype.hasOwnProperty.call(data, key) ? data[key] : placeholder,
  );

  // mjml v5 returns a Promise at runtime even though the TypeScript types
  // still describe a sync return. Await through `unknown` so we tolerate
  // both shapes — older v4 sync results pass through Promise.resolve.
  const result = (await Promise.resolve(mjml2html(compiledTemplate) as unknown)) as {
    html: string;
  };
  return result.html;
};
