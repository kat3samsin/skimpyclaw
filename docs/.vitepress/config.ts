import { defineConfig } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'

// https://vitepress.dev/reference/site-config
export default withMermaid({
  lang: 'en-US',
  title: '👙🦞 SkimpyClaw',
  titleTemplate: ':title | SkimpyClaw Docs',
  description: 'Lightweight personal AI assistant (~20k LOC). Runs locally.',

  // Use .html extension for compatibility with simple servers
  cleanUrls: false,
  
  // Ignore dead links during build
  ignoreDeadLinks: true,
  
  // Last updated timestamp
  lastUpdated: true,
  
  // Head/meta tags
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
    ['link', { rel: 'preconnect', href: 'https://fonts.googleapis.com' }],
    ['link', { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' }],
    ['meta', { name: 'theme-color', content: '#d33b36' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:site_name', content: 'SkimpyClaw' }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
  ],
  
  // Mermaid configuration
  mermaid: {
    theme: 'base',
    themeVariables: {
      primaryColor: '#f5ebe5',
      primaryTextColor: '#0c0303',
      primaryBorderColor: '#d33b36',
      lineColor: '#5a4a40',
      secondaryColor: '#fffaf5',
      tertiaryColor: '#f5ebe5',
      fontFamily: 'Inter, sans-serif',
    }
  },
  
  // Theme configuration
  themeConfig: {
    // Navigation
    nav: [
      { text: 'Guide', link: '/guide/index.html' },
      { text: 'API', link: '/api/index.html' },
      { text: 'Reference', link: '/reference/index.html' },
      { 
        text: 'v0.1',
        items: [
          { text: 'GitHub', link: 'https://github.com/kat3samsin/skimpyclaw' },
        ]
      }
    ],
    
    // Sidebar navigation
    sidebar: {
      '/guide/': [
        {
          text: 'Getting Started',
          collapsed: false,
          items: [
            { text: 'Introduction', link: '/guide/index.html' },
            { text: 'Setup Guide', link: '/guide/setup-guide.html' },
          ]
        },
        {
          text: 'Core Concepts',
          collapsed: false,
          items: [
            { text: 'Architecture', link: '/guide/architecture.html' },
            { text: 'Configuration', link: '/guide/configuration.html' },
            { text: 'Security', link: '/guide/security.html' },
            { text: 'Data Storage', link: '/guide/data-storage.html' },
          ]
        },
        {
          text: 'Features',
          collapsed: false,
          items: [
            { text: 'Tools', link: '/guide/tools.html' },
            { text: 'Coding Agents', link: '/guide/coding-agents.html' },
            { text: 'Sandbox', link: '/guide/sandbox.html' },
            { text: 'Exec Approval', link: '/guide/exec-approval.html' },
            { text: 'Skills', link: '/guide/skills.html' },
            { text: 'Dashboard', link: '/guide/dashboard.html' },
          ]
        },
        {
          text: 'Usage',
          collapsed: false,
          items: [
            { text: 'CLI', link: '/guide/cli.html' },
            { text: 'Chat Commands', link: '/guide/chat-commands.html' },
            { text: 'Discord Updates', link: '/guide/discord-updates.html' },
            { text: 'Changelog', link: '/guide/changelog.html' },
            { text: 'Troubleshooting', link: '/guide/troubleshooting.html' },
          ]
        },
      ],
      '/api/': [
        {
          text: 'API Reference',
          collapsed: false,
          items: [
            { text: 'Overview', link: '/api/index.html' },
            { text: 'REST API', link: '/api/rest-api.html' },
            { text: 'Dashboard API', link: '/api/dashboard-api.html' },
          ]
        }
      ],
      '/reference/': [
        {
          text: 'Reference',
          collapsed: false,
          items: [
            { text: 'Overview', link: '/reference/index.html' },
            { text: 'Config Options', link: '/reference/config-options.html' },
            { text: 'Environment Variables', link: '/reference/environment-variables.html' },
            { text: 'Model Aliases', link: '/reference/model-aliases.html' },
          ]
        }
      ]
    },
    
    // Search configuration
    search: {
      provider: 'local',
      options: {
        detailedView: true
      }
    },
    
    // Footer
    footer: {
      copyright: 'Copyright © 2026 SkimpyClaw'
    },
    
    // Social links
    socialLinks: [
      { icon: 'github', link: 'https://github.com/kat3samsin/skimpyclaw' },
    ],
    
    // Edit link
    editLink: {
      pattern: 'https://github.com/kat3samsin/skimpyclaw/edit/trunk/docs/:path'
    },
  },
  
  // Markdown configuration
  markdown: {
    theme: {
      light: 'github-light',
      dark: 'github-dark'
    },
    lineNumbers: true,
  },

})
