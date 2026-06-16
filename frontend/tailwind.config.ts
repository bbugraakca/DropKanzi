import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "var(--bg)",
        foreground: "var(--text-1)",
        card: "var(--surface)",
        canvas: "var(--bg)",
        muted: {
          DEFAULT: "var(--text-3)",
          foreground: "var(--text-3)",
        },
        border: "var(--border)",
        "border-subtle": "var(--border)",
        "border-default": "var(--border)",
        "border-strong": "var(--border-2)",
        accent: {
          DEFAULT: "var(--accent)",
          hover: "var(--accent-h)",
          light: "var(--accent-bg)",
          bg: "var(--accent-bg)",
          muted: "var(--text-3)",
          foreground: "#ffffff",
        },
        primary: {
          DEFAULT: "var(--accent)",
          foreground: "#ffffff",
        },
        destructive: "var(--red)",
        text: {
          primary: "var(--text-1)",
          secondary: "var(--text-2)",
          tertiary: "var(--text-3)",
          quaternary: "var(--text-3)",
          body: "var(--text-2)",
          muted: "var(--text-3)",
          1: "var(--text-1)",
          2: "var(--text-2)",
          3: "var(--text-3)",
        },
        surface: {
          DEFAULT: "var(--surface)",
          elevated: "var(--surface-2)",
          overlay: "var(--surface-2)",
          muted: "var(--surface-2)",
          2: "var(--surface-2)",
        },
        "surface-muted": "var(--surface-2)",
        "surface-hover": "var(--surface-2)",
        green: {
          DEFAULT: "var(--green)",
          bg: "var(--green-bg)",
        },
        red: {
          DEFAULT: "var(--red)",
          bg: "var(--red-bg)",
        },
        amber: {
          DEFAULT: "var(--amber)",
          bg: "var(--amber-bg)",
        },
        danger: "var(--red)",
        dangerLight: "var(--red-bg)",
        success: "var(--green)",
        warning: "var(--amber)",
      },
      fontFamily: {
        sans: ["var(--font-geist-sans)", "Geist", "sans-serif"],
        mono: ["var(--font-geist-mono)", "Geist Mono", "monospace"],
      },
      borderRadius: {
        lg: "12px",
        md: "7px",
        sm: "4px",
        xl: "16px",
      },
      boxShadow: {
        xs: "var(--shadow)",
        card: "var(--shadow)",
        sm: "var(--shadow)",
        md: "var(--shadow-md)",
        lg: "var(--shadow-md)",
        soft: "var(--shadow-md)",
        glow: "var(--shadow-md)",
      },
      transitionTimingFunction: {
        out: "cubic-bezier(0.16, 1, 0.3, 1)",
      },
    },
  },
  plugins: [],
};

export default config;
