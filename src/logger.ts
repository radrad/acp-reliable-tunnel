export interface Logger {
  info(message: string, details?: unknown): void;
  warn(message: string, details?: unknown): void;
  error(message: string, details?: unknown): void;
  debug(message: string, details?: unknown): void;
}

export class ConsoleLogger implements Logger {
  constructor(private readonly scope: string) {}

  info(message: string, details?: unknown): void {
    this.write("INFO", message, details);
  }

  warn(message: string, details?: unknown): void {
    this.write("WARN", message, details);
  }

  error(message: string, details?: unknown): void {
    this.write("ERROR", message, details);
  }

  debug(message: string, details?: unknown): void {
    if (process.env.ACP_TUNNEL_DEBUG !== "1") {
      return;
    }

    this.write("DEBUG", message, details);
  }

  private write(level: string, message: string, details?: unknown): void {
    if (details === undefined) {
      console.error(`[${level}] [${this.scope}] ${message}`);
      return;
    }

    console.error(`[${level}] [${this.scope}] ${message}`, details);
  }
}