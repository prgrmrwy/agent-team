/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // shadcn 兼容（其他 dialog / popover / button 还在用 HSL）
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },

        // ─── Sheikah Slate × Hyrule Parchment (M3 重构主用) ───
        slate: {
          bg: 'var(--slate-bg)',
          surface: 'var(--slate-surface)',
          elev: 'var(--slate-elev)',
          edge: 'var(--slate-edge)',
        },
        cyan: {
          DEFAULT: 'var(--cyan)',
          bright: 'var(--cyan-bright)',
          dim: 'var(--cyan-dim)',
        },
        ink: {
          white: 'var(--ink-white)',
          soft: 'var(--ink-soft)',
          dim: 'var(--ink-dim)',
          dimmer: 'var(--ink-dimmer)',
        },
        role: {
          planner: 'var(--planner)',
          engineer: 'var(--engineer)',
          qa: 'var(--qa)',
          anti: 'var(--anti)',
          ci: 'var(--ci)',
          pmux: 'var(--pmux)',
          link: 'var(--link)',
        },
        amber: 'var(--amber)',
        gold: 'var(--gold)',
        malice: 'var(--malice)',
        paper: {
          DEFAULT: 'var(--paper)',
          edge: 'var(--paper-edge)',
          shadow: 'var(--paper-shadow)',
          deep: 'var(--paper-deep)',
        },
      },
      fontFamily: {
        chrome: 'var(--font-chrome)',
        paper: 'var(--font-paper)',
      },
      borderRadius: {
        lg: 'var(--radius)',  // 2px
        md: '1px',
        sm: '0',
        DEFAULT: 'var(--radius)',
      },
    },
  },
  plugins: [],
}
