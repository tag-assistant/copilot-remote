// Agent discovery — scan standard locations for .agent.md files
// Locations: .github/agents/, .copilot/agents/, .claude/agents/, ~/.copilot/agents/
import * as fs from 'fs';
import * as path from 'path';

export interface DiscoveredAgent {
  name: string;
  displayName?: string;
  description?: string;
  tools?: string[] | null;
  prompt: string;
  mcpServers?: Record<string, unknown>;
  infer?: boolean;
  source: string; // file path
}

function parseAgentMd(filePath: string): DiscoveredAgent | null {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const name = path.basename(filePath, '.agent.md');
    
    // Parse YAML frontmatter if present
    let description: string | undefined;
    let tools: string[] | null | undefined;
    let prompt = content;
    
    const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
    if (fmMatch) {
      const fm = fmMatch[1];
      prompt = fmMatch[2].trim();
      
      // Simple YAML parsing for common fields
      const descMatch = fm.match(/description:\s*(.+)/);
      if (descMatch) description = descMatch[1].trim().replace(/^["']|["']$/g, '');
      
      const toolsMatch = fm.match(/tools:\s*\n((?:\s+-\s+.+\n?)*)/);
      if (toolsMatch) {
        tools = toolsMatch[1].split('\n')
          .map(l => l.replace(/^\s+-\s+/, '').trim())
          .filter(Boolean);
      }
    }
    
    return { name, description, prompt, tools, source: filePath };
  } catch {
    return null;
  }
}

export function discoverAgents(workDir: string): DiscoveredAgent[] {
  const homeDir = process.env.HOME ?? '';
  const searchDirs = [
    path.join(workDir, '.github', 'agents'),
    path.join(workDir, '.copilot', 'agents'),
    path.join(workDir, '.claude', 'agents'),
    path.join(homeDir, '.copilot', 'agents'),
  ];
  
  const agents: DiscoveredAgent[] = [];
  const seen = new Set<string>();
  
  for (const dir of searchDirs) {
    try {
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.agent.md'));
      for (const file of files) {
        const agent = parseAgentMd(path.join(dir, file));
        if (agent && !seen.has(agent.name)) {
          seen.add(agent.name);
          agents.push(agent);
        }
      }
    } catch {
      // dir doesn't exist, skip
    }
  }
  
  return agents;
}
