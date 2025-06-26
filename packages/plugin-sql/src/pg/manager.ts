import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolClient } from 'pg';
import { logger } from '@elizaos/core';

export class PostgresConnectionManager {
  private pool: Pool;
  private db: NodePgDatabase;

  constructor(connectionString: string) {
    // Configure connection pool with memory-optimized settings for idle state
    this.pool = new Pool({
      connectionString,
      max: 3, // Further reduce from 5 to 3 for aggressive memory optimization
      min: 0, // No minimum connections - close all when idle
      idleTimeoutMillis: 5000, // Close idle connections after 5 seconds (was 10s)
      connectionTimeoutMillis: 2000, // Timeout for new connections
      statement_timeout: 30000, // Reduce statement timeout to 30s (was 60s)
      query_timeout: 30000, // Reduce query timeout to 30s (was 60s)
      application_name: 'elizaos-agent', // For connection identification
    });
    this.db = drizzle(this.pool as any);
  }

  public getDatabase(): NodePgDatabase {
    return this.db;
  }

  public getConnection(): Pool {
    return this.pool;
  }

  public async getClient(): Promise<PoolClient> {
    return this.pool.connect();
  }

  public async testConnection(): Promise<boolean> {
    let client: PoolClient | null = null;
    try {
      client = await this.pool.connect();
      await client.query('SELECT 1');
      return true;
    } catch (error) {
      logger.error('Failed to connect to the database:', error);
      return false;
    } finally {
      if (client) {
        client.release();
      }
    }
  }

  /**
   * Closes the connection pool.
   * @returns {Promise<void>}
   * @memberof PostgresConnectionManager
   */
  public async close(): Promise<void> {
    await this.pool.end();
  }
}
