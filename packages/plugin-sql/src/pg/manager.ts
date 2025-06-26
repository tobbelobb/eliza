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
      max: 5, // Reduce from default 20 to limit memory usage
      min: 1, // Minimum connections to keep alive
      idleTimeoutMillis: 10000, // Close idle connections after 10 seconds
      connectionTimeoutMillis: 2000, // Timeout for new connections
      statement_timeout: 60000, // Statement timeout to prevent hanging queries
      query_timeout: 60000, // Query timeout
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
