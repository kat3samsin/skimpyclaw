#!/usr/bin/env node
/**
 * Mermaid to ASCII Converter
 * 
 * Converts mermaid diagrams to text-based ASCII diagrams.
 * Supports: flowchart, sequenceDiagram
 * 
 * Usage:
 *   node mermaid-to-ascii.js < input.mmd
 *   node mermaid-to-ascii.js input.mmd
 */

const fs = require('fs');

function parseMermaid(content) {
  const lines = content.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('%%'));
  const type = lines[0]?.match(/^(flowchart|sequenceDiagram|graph)/)?.[1] || 'flowchart';
  return { type, lines };
}

function flowchartToAscii(lines) {
  const nodes = new Map();
  const edges = [];
  
  // Parse nodes and edges
  for (const line of lines.slice(1)) {
    // Node definition: id["label"] or id["label"]
    const nodeMatch = line.match(/^(\w+)\[("?)([^"\]]+)\2\]$/);
    if (nodeMatch) {
      nodes.set(nodeMatch[1], nodeMatch[3]);
      continue;
    }
    
    // Simple node: id
    if (line.match(/^\w+$/) && !line.includes('-->') && !line.includes('---')) {
      nodes.set(line, line);
      continue;
    }
    
    // Edge: A --> B or A["X"] --> B["Y"]
    const edgeMatch = line.match(/^(\w+)(?:\[[^\]]*\])?\s*(-->|---|==>|<--|\.->)\s*(\w+)(?:\[[^\]]*\])?$/);
    if (edgeMatch) {
      edges.push({ from: edgeMatch[1], to: edgeMatch[3], type: edgeMatch[2] });
      if (!nodes.has(edgeMatch[1])) nodes.set(edgeMatch[1], edgeMatch[1]);
      if (!nodes.has(edgeMatch[3])) nodes.set(edgeMatch[3], edgeMatch[3]);
    }
  }
  
  // Generate ASCII
  let ascii = '';
  const nodeArray = Array.from(nodes.entries());
  
  if (nodeArray.length === 0) return '(empty diagram)';
  
  // Simple horizontal layout
  const maxLabelLen = Math.max(...nodeArray.map(([, label]) => label.length));
  const boxWidth = maxLabelLen + 4;
  
  // Top border
  ascii += '┌' + '─'.repeat(boxWidth - 2) + '┐\n';
  
  // Nodes with vertical spacing
  for (let i = 0; i < nodeArray.length; i++) {
    const [id, label] = nodeArray[i];
    const padding = boxWidth - 2 - label.length;
    const leftPad = Math.floor(padding / 2);
    const rightPad = padding - leftPad;
    ascii += '│' + ' '.repeat(leftPad) + label + ' '.repeat(rightPad) + '│\n';
    
    // Connection to next node
    if (i < nodeArray.length - 1) {
      const edge = edges.find(e => e.from === nodeArray[i][0] && e.to === nodeArray[i + 1][0]);
      if (edge) {
        ascii += '│' + ' '.repeat(Math.floor((boxWidth - 2) / 2)) + '↓' + ' '.repeat(Math.ceil((boxWidth - 2) / 2) - 1) + '│\n';
      } else {
        ascii += '├' + '─'.repeat(boxWidth - 2) + '┤\n';
      }
    }
  }
  
  // Bottom border
  ascii += '└' + '─'.repeat(boxWidth - 2) + '┘';
  
  return ascii;
}

function sequenceDiagramToAscii(lines) {
  const participants = [];
  const messages = [];
  
  for (const line of lines.slice(1)) {
    // Participant: participant A as Agent
    const participantMatch = line.match(/^participant\s+(\w+)\s+as\s+(.+)$/i);
    if (participantMatch) {
      participants.push({ id: participantMatch[1], label: participantMatch[2] });
      continue;
    }
    
    // Simple participant: participant A
    const simpleParticipantMatch = line.match(/^participant\s+(\w+)$/i);
    if (simpleParticipantMatch && !participants.find(p => p.id === simpleParticipantMatch[1])) {
      participants.push({ id: simpleParticipantMatch[1], label: simpleParticipantMatch[1] });
      continue;
    }
    
    // Message: A->>B: message or A-->>B: message
    const messageMatch = line.match(/^(\w+)(-?-?>>?)(\w+)\s*:\s*(.+)$/);
    if (messageMatch) {
      messages.push({
        from: messageMatch[1],
        to: messageMatch[3],
        arrow: messageMatch[2],
        text: messageMatch[4]
      });
    }
  }
  
  if (participants.length === 0) return '(empty diagram)';
  
  // Generate ASCII sequence diagram
  let ascii = '';
  const colWidth = 20;
  
  // Header with participant names
  let header = '';
  for (const p of participants) {
    const label = p.label.length > colWidth - 2 ? p.label.slice(0, colWidth - 3) + '…' : p.label;
    const pad = colWidth - label.length;
    header += '│' + ' '.repeat(Math.floor(pad / 2)) + label + ' '.repeat(Math.ceil(pad / 2));
  }
  header += '│';
  ascii += '┌' + '─'.repeat(header.length - 2) + '┐\n';
  ascii += header + '\n';
  
  // Lifelines
  let lifelines = '';
  for (let i = 0; i < participants.length; i++) {
    lifelines += '│' + ' '.repeat(Math.floor(colWidth / 2)) + '┋' + ' '.repeat(Math.ceil(colWidth / 2) - 1);
  }
  lifelines += '│';
  ascii += lifelines + '\n';
  
  // Messages
  for (const msg of messages) {
    const fromIdx = participants.findIndex(p => p.id === msg.from);
    const toIdx = participants.findIndex(p => p.id === msg.to);
    
    if (fromIdx === -1 || toIdx === -1) continue;
    
    let msgLine = '';
    for (let i = 0; i < participants.length; i++) {
      if (i === fromIdx && fromIdx < toIdx) {
        // Arrow right
        const arrowLen = (toIdx - fromIdx) * colWidth - 2;
        const text = msg.text.length > arrowLen - 4 ? msg.text.slice(0, arrowLen - 5) + '…' : msg.text;
        const padding = arrowLen - text.length - 2;
        msgLine += '│' + '─'.repeat(2) + text + '─'.repeat(padding) + '>' + ' '.repeat(2);
      } else if (i === toIdx && fromIdx > toIdx) {
        // Arrow left
        msgLine += '│<─' + '─'.repeat(colWidth - 4) + ' ';
      } else if (i > fromIdx && i < toIdx) {
        msgLine += '│' + '─'.repeat(colWidth);
      } else if (i > toIdx && i < fromIdx) {
        msgLine += '│' + '─'.repeat(colWidth);
      } else {
        msgLine += '│' + ' '.repeat(colWidth);
      }
    }
    msgLine += '│';
    ascii += msgLine + '\n';
    ascii += lifelines + '\n';
  }
  
  ascii += '└' + '─'.repeat(header.length - 2) + '┘';
  
  return ascii;
}

function convert(content) {
  const { type, lines } = parseMermaid(content);
  
  switch (type) {
    case 'flowchart':
    case 'graph':
      return flowchartToAscii(lines);
    case 'sequenceDiagram':
      return sequenceDiagramToAscii(lines);
    default:
      return `(Unsupported diagram type: ${type})`;
  }
}

// Main
const input = process.argv[2] 
  ? fs.readFileSync(process.argv[2], 'utf-8')
  : fs.readFileSync(0, 'utf-8');

// Find all mermaid blocks and convert them
const mermaidBlocks = input.match(/```mermaid\n([\s\S]*?)```/g) || [];

let output = input;
for (const block of mermaidBlocks) {
  const content = block.replace(/```mermaid\n/, '').replace(/```$/, '');
  const ascii = convert(content);
  const wrapped = '```\n' + ascii + '\n```\n*(ASCII representation)*';
  output = output.replace(block, block + '\n\n' + wrapped);
}

console.log(output);
