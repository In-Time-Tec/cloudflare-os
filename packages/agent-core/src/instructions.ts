// Formatting of deployment-wide admin instructions for the agent system prompt.

export function formatInstanceInstructions(instructions: string): string {
  let trimmed = instructions.trim();
  if (!trimmed) return "";
  return `# Deployment-specific instructions\n\n` +
      `The administrator of this deployment has provided the following additional instructions. ` +
      `Follow them unless they conflict with the user's safety or the instructions above.\n\n` +
      `<deployment_instructions>\n${trimmed}\n</deployment_instructions>`;
}
