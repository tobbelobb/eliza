import {
  type Agent,
  ChannelType,
  type Component,
  DatabaseAdapter,
  type Entity,
  type Log,
  logger,
  type Memory,
  type MemoryMetadata,
  type Participant,
  type Relationship,
  type Room,
  RoomMetadata,
  type Task,
  TaskMetadata,
  type UUID,
  type World,
} from '@elizaos/core';
import {
  and,
  cosineDistance,
  count,
  desc,
  eq,
  gte,
  inArray,
  lt,
  lte,
  or,
  SQL,
  sql,
} from 'drizzle-orm';
import { v4 } from 'uuid';
import { DIMENSION_MAP, type EmbeddingDimensionColumn } from './schema/embedding';
import {
  agentTable,
  cacheTable,
  channelParticipantsTable,
  channelTable,
  componentTable,
  embeddingTable,
  entityTable,
  logTable,
  memoryTable,
  messageServerTable,
  messageTable,
  participantTable,
  relationshipTable,
  roomTable,
  serverAgentsTable,
  taskTable,
  worldTable,
} from './schema/index';

// Define the metadata type inline since we can't import it
/**
 * Represents metadata information about memory.
 * @typedef {Object} MemoryMetadata
 * @property {string} type - The type of memory.
 * @property {string} [source] - The source of the memory.
 * @property {UUID} [sourceId] - The ID of the source.
 * @property {string} [scope] - The scope of the memory.
 * @property {number} [timestamp] - The timestamp of the memory.
 * @property {string[]} [tags] - The tags associated with the memory.
 * @property {UUID} [documentId] - The ID of the document associated with the memory.
 * @property {number} [position] - The position of the memory.
 */

/**
 * Abstract class representing a base Drizzle adapter for working with databases.
 * This adapter provides a comprehensive set of methods for interacting with a database
 * using Drizzle ORM. It implements the DatabaseAdapter interface and handles operations
 * for various entity types including agents, entities, components, memories, rooms,
 * participants, relationships, tasks, and more.
 *
 * The adapter includes built-in retry logic for database operations, embedding dimension
 * management, and transaction support. Concrete implementations must provide the
 * withDatabase method to execute operations against their specific database.
 */
export abstract class BaseDrizzleAdapter extends DatabaseAdapter<any> {
  protected readonly maxRetries: number = 3;
  protected readonly baseDelay: number = 1000;
  protected readonly maxDelay: number = 10000;
  protected readonly jitterMax: number = 1000;
  protected embeddingDimension: EmbeddingDimensionColumn = DIMENSION_MAP[384];

  protected abstract withDatabase<T>(operation: () => Promise<T>): Promise<T>;
  public abstract init(): Promise<void>;
  public abstract close(): Promise<void>;

  /**
   * Initialize method that can be overridden by implementations
   */
  public async initialize(): Promise<void> {
    await this.init();
  }

  /**
   * Get the underlying database instance for testing purposes
   */
  public getDatabase(): any {
    return this.db;
  }

  protected agentId: UUID;

  /**
   * Constructor for creating a new instance of Agent with the specified agentId.
   *
   * @param {UUID} agentId - The unique identifier for the agent.
   */
  constructor(agentId: UUID) {
    super();
    this.agentId = agentId;
  }

  /**
   * Executes the given operation with retry logic.
   * @template T
   * @param {() => Promise<T>} operation - The operation to be executed.
   * @returns {Promise<T>} A promise that resolves with the result of the operation.
   */
  protected async withRetry<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: Error = new Error('Unknown error');

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error as Error;

        if (attempt < this.maxRetries) {
          const backoffDelay = Math.min(this.baseDelay * 2 ** (attempt - 1), this.maxDelay);

          const jitter = Math.random() * this.jitterMax;
          const delay = backoffDelay + jitter;

          logger.warn(`Database operation failed (attempt ${attempt}/${this.maxRetries}):`, {
            error: error instanceof Error ? error.message : String(error),
            nextRetryIn: `${(delay / 1000).toFixed(1)}s`,
          });

          await new Promise((resolve) => setTimeout(resolve, delay));
        } else {
          logger.error('Max retry attempts reached:', {
            error: error instanceof Error ? error.message : String(error),
            totalAttempts: attempt,
          });
          throw error instanceof Error ? error : new Error(String(error));
        }
      }
    }

    throw lastError;
  }

  /**
   * Asynchronously ensures that the given embedding dimension is valid for the agent.
   *
   * @param {number} dimension - The dimension to ensure for the embedding.
   * @returns {Promise<void>} - Resolves once the embedding dimension is ensured.
   */
  async ensureEmbeddingDimension(dimension: number) {
    return this.withDatabase(async () => {
      const existingMemory = await this.db
        .select()
        .from(memoryTable)
        .innerJoin(embeddingTable, eq(embeddingTable.memoryId, memoryTable.id))
        .where(eq(memoryTable.agentId, this.agentId))
        .limit(1);

      if (existingMemory.length > 0) {
        Object.entries(DIMENSION_MAP).find(
          ([_, colName]) => (existingMemory[0] as any).embeddings[colName] !== null
        );
        // We don't actually need to use usedDimension for now, but it's good to know it's there.
      }

      this.embeddingDimension = DIMENSION_MAP[dimension];
    });
  }

  /**
   * Asynchronously retrieves an agent by their ID from the database.
   * @param {UUID} agentId - The ID of the agent to retrieve.
   * @returns {Promise<Agent | null>} A promise that resolves to the retrieved agent or null if not found.
   */
  async getAgent(agentId: UUID): Promise<Agent | null> {
    return this.withDatabase(async () => {
      const rows = await this.db
        .select()
        .from(agentTable)
        .where(eq(agentTable.id, agentId))
        .limit(1);

      if (rows.length === 0) return null;

      const row = rows[0];
      return {
        ...row,
        username: row.username || '',
        id: row.id as UUID,
        system: !row.system ? undefined : row.system,
        bio: !row.bio ? '' : row.bio,
        createdAt: row.createdAt.getTime(),
        updatedAt: row.updatedAt.getTime(),
      };
    });
  }

  /**
   * Asynchronously retrieves a list of agents from the database.
   *
   * @returns {Promise<Partial<Agent>[]>} A Promise that resolves to an array of Agent objects.
   */
  async getAgents(): Promise<Partial<Agent>[]> {
    return this.withDatabase(async () => {
      const rows = await this.db
        .select({
          id: agentTable.id,
          name: agentTable.name,
          bio: agentTable.bio,
        })
        .from(agentTable);
      return rows.map((row) => ({
        ...row,
        id: row.id as UUID,
        bio: row.bio === null ? '' : row.bio,
      }));
    });
  }
  /**
   * Asynchronously creates a new agent record in the database.
   *
   * @param {Partial<Agent>} agent The agent object to be created.
   * @returns {Promise<boolean>} A promise that resolves to a boolean indicating the success of the operation.
   */
  async createAgent(agent: Agent): Promise<boolean> {
    return this.withDatabase(async () => {
      try {
        // Check for existing agent with the same ID or name
        // Check for existing agent with the same ID or name
        const conditions: (SQL<unknown> | undefined)[] = [];
        if (agent.id) {
          conditions.push(eq(agentTable.id, agent.id));
        }
        if (agent.name) {
          conditions.push(eq(agentTable.name, agent.name));
        }

        const existing =
          conditions.length > 0
            ? await this.db
                .select({ id: agentTable.id })
                .from(agentTable)
                .where(or(...conditions))
                .limit(1)
            : [];

        if (existing.length > 0) {
          logger.warn('Attempted to create an agent with a duplicate ID or name.', {
            id: agent.id,
            name: agent.name,
          });
          return false;
        }

        await this.db.transaction(async (tx) => {
          await tx.insert(agentTable).values({
            ...agent,
            createdAt: new Date(agent.createdAt || Date.now()),
            updatedAt: new Date(agent.updatedAt || Date.now()),
          });
        });

        logger.debug('Agent created successfully:', {
          agentId: agent.id,
        });
        return true;
      } catch (error) {
        logger.error('Error creating agent:', {
          error: error instanceof Error ? error.message : String(error),
          agentId: agent.id,
          agent,
        });
        return false;
      }
    });
  }

  /**
   * Updates an agent in the database with the provided agent ID and data.
   * @param {UUID} agentId - The unique identifier of the agent to update.
   * @param {Partial<Agent>} agent - The partial agent object containing the fields to update.
   * @returns {Promise<boolean>} - A boolean indicating if the agent was successfully updated.
   */
  async updateAgent(agentId: UUID, agent: Partial<Agent>): Promise<boolean> {
    return this.withDatabase(async () => {
      try {
        if (!agentId) {
          throw new Error('Agent ID is required for update');
        }

        await this.db.transaction(async (tx) => {
          // Handle settings update if present
          if (agent?.settings) {
            agent.settings = await this.mergeAgentSettings(tx, agentId, agent.settings);
          }

          // Convert numeric timestamps to Date objects for database storage
          // The Agent interface uses numbers, but the database schema expects Date objects
          const updateData: any = { ...agent };
          if (updateData.createdAt) {
            if (typeof updateData.createdAt === 'number') {
              updateData.createdAt = new Date(updateData.createdAt);
            } else {
              delete updateData.createdAt; // Don't update createdAt if it's not a valid timestamp
            }
          }
          if (updateData.updatedAt) {
            if (typeof updateData.updatedAt === 'number') {
              updateData.updatedAt = new Date(updateData.updatedAt);
            } else {
              updateData.updatedAt = new Date(); // Use current time if invalid
            }
          } else {
            updateData.updatedAt = new Date(); // Always set updatedAt to current time
          }

          await tx.update(agentTable).set(updateData).where(eq(agentTable.id, agentId));
        });

        logger.debug('Agent updated successfully:', {
          agentId,
        });
        return true;
      } catch (error) {
        logger.error('Error updating agent:', {
          error: error instanceof Error ? error.message : String(error),
          agentId,
          agent,
        });
        return false;
      }
    });
  }

  /**
   * Merges updated agent settings with existing settings in the database,
   * with special handling for nested objects like secrets.
   * @param tx - The database transaction
   * @param agentId - The ID of the agent
   * @param updatedSettings - The settings object with updates
   * @returns The merged settings object
   * @private
   */
  private async mergeAgentSettings(tx: any, agentId: UUID, updatedSettings: any): Promise<any> {
    // First get the current agent data
    const currentAgent = await tx
      .select({ settings: agentTable.settings })
      .from(agentTable)
      .where(eq(agentTable.id, agentId))
      .limit(1);

    const currentSettings =
      currentAgent.length > 0 && currentAgent[0].settings ? currentAgent[0].settings : {};

    const deepMerge = (target: any, source: any): any => {
      // If source is explicitly null, it means the intention is to set this entire branch to null (or delete if top-level handled by caller).
      // For recursive calls, if a sub-object in source is null, it effectively means "remove this sub-object from target".
      // However, our primary deletion signal is a *property value* being null within an object.
      if (source === null) {
        // If the entire source for a given key is null, we treat it as "delete this key from target"
        // by returning undefined, which the caller can use to delete the key.
        return undefined;
      }

      // If source is an array or a primitive, it replaces the target value.
      if (Array.isArray(source) || typeof source !== 'object') {
        return source;
      }

      // Initialize output. If target is not an object, start with an empty one to merge source into.
      const output =
        typeof target === 'object' && target !== null && !Array.isArray(target)
          ? { ...target }
          : {};

      for (const key of Object.keys(source)) {
        // Iterate over source keys
        const sourceValue = source[key];

        if (sourceValue === null) {
          // If a value in source is null, delete the corresponding key from output.
          delete output[key];
        } else if (typeof sourceValue === 'object' && !Array.isArray(sourceValue)) {
          // If value is an object, recurse.
          const nestedMergeResult = deepMerge(output[key], sourceValue);
          if (nestedMergeResult === undefined) {
            // If recursive merge resulted in undefined (meaning the nested object should be deleted)
            delete output[key];
          } else {
            output[key] = nestedMergeResult;
          }
        } else {
          // Primitive or array value from source, assign it.
          output[key] = sourceValue;
        }
      }

      // After processing all keys from source, check if output became empty.
      // An object is empty if all its keys were deleted or resulted in undefined.
      // This is a more direct check than iterating 'output' after building it.
      if (Object.keys(output).length === 0) {
        // If the source itself was not an explicitly empty object,
        // and the merge resulted in an empty object, signal deletion.
        if (!(typeof source === 'object' && source !== null && Object.keys(source).length === 0)) {
          return undefined; // Signal to delete this (parent) key if it became empty.
        }
      }

      return output;
    }; // End of deepMerge

    const finalSettings = deepMerge(currentSettings, updatedSettings);
    // If the entire settings object becomes undefined (e.g. all keys removed),
    // return an empty object instead of undefined/null to keep the settings field present.
    return finalSettings === undefined ? {} : finalSettings;
  }

  /**
   * Asynchronously deletes an agent with the specified UUID and all related entries.
   *
   * @param {UUID} agentId - The UUID of the agent to be deleted.
   * @returns {Promise<boolean>} - A boolean indicating if the deletion was successful.
   */
  async deleteAgent(agentId: UUID): Promise<boolean> {
    logger.debug(`[DB] Deleting agent with ID: ${agentId}`);

    return this.withDatabase(async () => {
      try {
        // Simply delete the agent - all related data will be cascade deleted
        const result = await this.db
          .delete(agentTable)
          .where(eq(agentTable.id, agentId))
          .returning();

        if (result.length === 0) {
          logger.warn(`[DB] Agent ${agentId} not found`);
          return false;
        }

        logger.success(
          `[DB] Agent ${agentId} and all related data successfully deleted via cascade`
        );
        return true;
      } catch (error) {
        logger.error(`[DB] Failed to delete agent ${agentId}:`, error);
        if (error instanceof Error) {
          logger.error(`[DB] Error details: ${error.name} - ${error.message}`);
          logger.error(`[DB] Stack trace: ${error.stack}`);
        }
        throw error;
      }
    });
  }

  /**
   * Count all agents in the database
   * Used primarily for maintenance and cleanup operations
   */
  /**
   * Asynchronously counts the number of agents in the database.
   * @returns {Promise<number>} A Promise that resolves to the number of agents in the database.
   */
  async countAgents(): Promise<number> {
    return this.withDatabase(async () => {
      try {
        const result = await this.db.select({ count: count() }).from(agentTable);

        return result[0]?.count || 0;
      } catch (error) {
        logger.error('Error counting agents:', {
          error: error instanceof Error ? error.message : String(error),
        });
        return 0;
      }
    });
  }

  /**
   * Clean up the agents table by removing all agents
   * This is used during server startup to ensure no orphaned agents exist
   * from previous crashes or improper shutdowns
   */
  async cleanupAgents(): Promise<void> {
    return this.withDatabase(async () => {
      try {
        await this.db.delete(agentTable);
        logger.success('Successfully cleaned up agent table');
      } catch (error) {
        logger.error('Error cleaning up agent table:', {
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    });
  }

  /**
   * Asynchronously retrieves an entity and its components by entity IDs.
   * @param {UUID[]} entityIds - The unique identifiers of the entities to retrieve.
   * @returns {Promise<Entity[] | null>} A Promise that resolves to the entity with its components if found, null otherwise.
   */
  async getEntityByIds(entityIds: UUID[]): Promise<Entity[] | null> {
    return this.withDatabase(async () => {
      const result = await this.db
        .select({
          entity: entityTable,
          components: componentTable,
        })
        .from(entityTable)
        .leftJoin(componentTable, eq(componentTable.entityId, entityTable.id))
        .where(inArray(entityTable.id, entityIds));

      if (result.length === 0) return [];

      // Group components by entity
      const entities: Record<UUID, Entity> = {};
      const entityComponents: Record<UUID, Entity['components']> = {};
      for (const e of result) {
        const key = e.entity.id;
        entities[key] = e.entity;
        if (entityComponents[key] === undefined) entityComponents[key] = [];
        if (e.components) {
          // Handle both single component and array of components
          const componentsArray = Array.isArray(e.components) ? e.components : [e.components];
          entityComponents[key] = [...entityComponents[key], ...componentsArray];
        }
      }
      for (const k of Object.keys(entityComponents)) {
        entities[k].components = entityComponents[k];
      }

      return Object.values(entities);
    });
  }

  /**
   * Asynchronously retrieves all entities for a given room, optionally including their components.
   * @param {UUID} roomId - The unique identifier of the room to get entities for
   * @param {boolean} [includeComponents] - Whether to include component data for each entity
   * @returns {Promise<Entity[]>} A Promise that resolves to an array of entities in the room
   */
  async getEntitiesForRoom(roomId: UUID, includeComponents?: boolean): Promise<Entity[]> {
    return this.withDatabase(async () => {
      const query = this.db
        .select({
          entity: entityTable,
          ...(includeComponents && { components: componentTable }),
        })
        .from(participantTable)
        .leftJoin(
          entityTable,
          and(eq(participantTable.entityId, entityTable.id), eq(entityTable.agentId, this.agentId))
        );

      if (includeComponents) {
        query.leftJoin(componentTable, eq(componentTable.entityId, entityTable.id));
      }

      const result = await query.where(eq(participantTable.roomId, roomId));

      // Group components by entity if includeComponents is true
      const entitiesByIdMap = new Map<UUID, Entity>();

      for (const row of result) {
        if (!row.entity) continue;

        const entityId = row.entity.id as UUID;
        if (!entitiesByIdMap.has(entityId)) {
          const entity: Entity = {
            ...row.entity,
            id: entityId,
            agentId: row.entity.agentId as UUID,
            metadata: row.entity.metadata as { [key: string]: any },
            components: includeComponents ? [] : undefined,
          };
          entitiesByIdMap.set(entityId, entity);
        }

        if (includeComponents && row.components) {
          const entity = entitiesByIdMap.get(entityId);
          if (entity) {
            if (!entity.components) {
              entity.components = [];
            }
            entity.components.push(row.components);
          }
        }
      }

      return Array.from(entitiesByIdMap.values());
    });
  }

  /**
   * Asynchronously creates new entities in the database.
   * @param {Entity[]} entities - The entity objects to be created.
   * @returns {Promise<boolean>} A Promise that resolves to a boolean indicating the success of the operation.
   */
  async createEntities(entities: Entity[]): Promise<boolean> {
    return this.withDatabase(async () => {
      try {
        return await this.db.transaction(async (tx) => {
          await tx.insert(entityTable).values(entities);

          logger.debug(entities.length, 'Entities created successfully');

          return true;
        });
      } catch (error) {
        logger.error('Error creating entity:', {
          error: error instanceof Error ? error.message : String(error),
          entityId: entities[0].id,
          name: entities[0].metadata?.name,
        });
        // trace the error
        logger.trace(error);
        return false;
      }
    });
  }

  /**
   * Asynchronously ensures an entity exists, creating it if it doesn't
   * @param entity The entity to ensure exists
   * @returns Promise resolving to boolean indicating success
   */
  protected async ensureEntityExists(entity: Entity): Promise<boolean> {
    if (!entity.id) {
      logger.error('Entity ID is required for ensureEntityExists');
      return false;
    }

    try {
      const existingEntities = await this.getEntityByIds([entity.id]);

      if (!existingEntities || !existingEntities.length) {
        return await this.createEntities([entity]);
      }

      return true;
    } catch (error) {
      logger.error('Error ensuring entity exists:', {
        error: error instanceof Error ? error.message : String(error),
        entityId: entity.id,
      });
      return false;
    }
  }

  /**
   * Asynchronously updates an entity in the database.
   * @param {Entity} entity - The entity object to be updated.
   * @returns {Promise<void>} A Promise that resolves when the entity is updated.
   */
  async updateEntity(entity: Entity): Promise<void> {
    if (!entity.id) {
      throw new Error('Entity ID is required for update');
    }
    return this.withDatabase(async () => {
      await this.db
        .update(entityTable)
        .set(entity)
        .where(eq(entityTable.id, entity.id as string));
    });
  }

  /**
   * Asynchronously deletes an entity from the database based on the provided ID.
   * @param {UUID} entityId - The ID of the entity to delete.
   * @returns {Promise<void>} A Promise that resolves when the entity is deleted.
   */
  async deleteEntity(entityId: UUID): Promise<void> {
    return this.withDatabase(async () => {
      await this.db.transaction(async (tx) => {
        // Delete related components first
        await tx
          .delete(componentTable)
          .where(
            or(eq(componentTable.entityId, entityId), eq(componentTable.sourceEntityId, entityId))
          );

        // Delete the entity
        await tx.delete(entityTable).where(eq(entityTable.id, entityId));
      });
    });
  }

  /**
   * Asynchronously retrieves entities by their names and agentId.
   * @param {Object} params - The parameters for retrieving entities.
   * @param {string[]} params.names - The names to search for.
   * @param {UUID} params.agentId - The agent ID to filter by.
   * @returns {Promise<Entity[]>} A Promise that resolves to an array of entities.
   */
  async getEntitiesByNames(params: { names: string[]; agentId: UUID }): Promise<Entity[]> {
    return this.withDatabase(async () => {
      const { names, agentId } = params;

      // Build a condition to match any of the names
      const nameConditions = names.map((name) => sql`${name} = ANY(${entityTable.names})`);

      const query = sql`
        SELECT * FROM ${entityTable}
        WHERE ${entityTable.agentId} = ${agentId}
        AND (${sql.join(nameConditions, sql` OR `)})
      `;

      const result = await this.db.execute(query);

      return result.rows.map((row: any) => ({
        id: row.id as UUID,
        agentId: row.agentId as UUID,
        names: row.names || [],
        metadata: row.metadata || {},
      }));
    });
  }

  /**
   * Asynchronously searches for entities by name with fuzzy matching.
   * @param {Object} params - The parameters for searching entities.
   * @param {string} params.query - The search query.
   * @param {UUID} params.agentId - The agent ID to filter by.
   * @param {number} params.limit - The maximum number of results to return.
   * @returns {Promise<Entity[]>} A Promise that resolves to an array of entities.
   */
  async searchEntitiesByName(params: {
    query: string;
    agentId: UUID;
    limit?: number;
  }): Promise<Entity[]> {
    return this.withDatabase(async () => {
      const { query, agentId, limit = 10 } = params;

      // If query is empty, return all entities up to limit
      if (!query || query.trim() === '') {
        const result = await this.db
          .select()
          .from(entityTable)
          .where(eq(entityTable.agentId, agentId))
          .limit(limit);

        return result.map((row: any) => ({
          id: row.id as UUID,
          agentId: row.agentId as UUID,
          names: row.names || [],
          metadata: row.metadata || {},
        }));
      }

      // Otherwise, search for entities with names containing the query (case-insensitive)
      const searchQuery = sql`
        SELECT * FROM ${entityTable}
        WHERE ${entityTable.agentId} = ${agentId}
        AND EXISTS (
          SELECT 1 FROM unnest(${entityTable.names}) AS name
          WHERE LOWER(name) LIKE LOWER(${'%' + query + '%'})
        )
        LIMIT ${limit}
      `;

      const result = await this.db.execute(searchQuery);

      return result.rows.map((row: any) => ({
        id: row.id as UUID,
        agentId: row.agentId as UUID,
        names: row.names || [],
        metadata: row.metadata || {},
      }));
    });
  }

  async getComponent(
    entityId: UUID,
    type: string,
    worldId?: UUID,
    sourceEntityId?: UUID
  ): Promise<Component | null> {
    return this.withDatabase(async () => {
      const conditions = [eq(componentTable.entityId, entityId), eq(componentTable.type, type)];

      if (worldId) {
        conditions.push(eq(componentTable.worldId, worldId));
      }

      if (sourceEntityId) {
        conditions.push(eq(componentTable.sourceEntityId, sourceEntityId));
      }

      const result = await this.db
        .select()
        .from(componentTable)
        .where(and(...conditions));

      if (result.length === 0) return null;

      const component = result[0];

      return {
        ...component,
        id: component.id as UUID,
        entityId: component.entityId as UUID,
        agentId: component.agentId as UUID,
        roomId: component.roomId as UUID,
        worldId: (component.worldId ?? '') as UUID,
        sourceEntityId: (component.sourceEntityId ?? '') as UUID,
        data: component.data as { [key: string]: any },
        createdAt: component.createdAt.getTime(),
      };
    });
  }

  /**
   * Asynchronously retrieves all components for a given entity, optionally filtered by world and source entity.
   * @param {UUID} entityId - The unique identifier of the entity to retrieve components for
   * @param {UUID} [worldId] - Optional world ID to filter components by
   * @param {UUID} [sourceEntityId] - Optional source entity ID to filter components by
   * @returns {Promise<Component[]>} A Promise that resolves to an array of components
   */
  async getComponents(entityId: UUID, worldId?: UUID, sourceEntityId?: UUID): Promise<Component[]> {
    return this.withDatabase(async () => {
      const conditions = [eq(componentTable.entityId, entityId)];

      if (worldId) {
        conditions.push(eq(componentTable.worldId, worldId));
      }

      if (sourceEntityId) {
        conditions.push(eq(componentTable.sourceEntityId, sourceEntityId));
      }

      const result = await this.db
        .select({
          id: componentTable.id,
          entityId: componentTable.entityId,
          type: componentTable.type,
          data: componentTable.data,
          worldId: componentTable.worldId,
          agentId: componentTable.agentId,
          roomId: componentTable.roomId,
          sourceEntityId: componentTable.sourceEntityId,
          createdAt: componentTable.createdAt,
        })
        .from(componentTable)
        .where(and(...conditions));

      if (result.length === 0) return [];

      const components = result.map((component) => ({
        ...component,
        id: component.id as UUID,
        entityId: component.entityId as UUID,
        agentId: component.agentId as UUID,
        roomId: component.roomId as UUID,
        worldId: (component.worldId ?? '') as UUID,
        sourceEntityId: (component.sourceEntityId ?? '') as UUID,
        data: component.data as { [key: string]: any },
        createdAt: component.createdAt.getTime(),
      }));

      return components;
    });
  }

  /**
   * Asynchronously creates a new component in the database.
   * @param {Component} component - The component object to be created.
   * @returns {Promise<boolean>} A Promise that resolves to a boolean indicating the success of the operation.
   */
  async createComponent(component: Component): Promise<boolean> {
    return this.withDatabase(async () => {
      await this.db.insert(componentTable).values({
        ...component,
        createdAt: new Date(component.createdAt),
      });
      return true;
    });
  }

  /**
   * Asynchronously updates an existing component in the database.
   * @param {Component} component - The component object to be updated.
   * @returns {Promise<void>} A Promise that resolves when the component is updated.
   */
  async updateComponent(component: Component): Promise<void> {
    return this.withDatabase(async () => {
      await this.db
        .update(componentTable)
        .set({
          ...component,
          createdAt: new Date(component.createdAt),
        })
        .where(eq(componentTable.id, component.id));
    });
  }

  /**
   * Asynchronously deletes a component from the database.
   * @param {UUID} componentId - The unique identifier of the component to delete.
   * @returns {Promise<void>} A Promise that resolves when the component is deleted.
   */
  async deleteComponent(componentId: UUID): Promise<void> {
    return this.withDatabase(async () => {
      await this.db.delete(componentTable).where(eq(componentTable.id, componentId));
    });
  }

  /**
   * Asynchronously retrieves memories from the database based on the provided parameters.
   * @param {Object} params - The parameters for retrieving memories.
   * @param {UUID} params.roomId - The ID of the room to retrieve memories for.
   * @param {number} [params.count] - The maximum number of memories to retrieve.
   * @param {boolean} [params.unique] - Whether to retrieve unique memories only.
   * @param {string} [params.tableName] - The name of the table to retrieve memories from.
   * @param {number} [params.start] - The start date to retrieve memories from.
   * @param {number} [params.end] - The end date to retrieve memories from.
   * @returns {Promise<Memory[]>} A Promise that resolves to an array of memories.
   */
  async getMemories(params: {
    entityId?: UUID;
    agentId?: UUID;
    count?: number;
    unique?: boolean;
    tableName: string;
    start?: number;
    end?: number;
    roomId?: UUID;
    worldId?: UUID;
  }): Promise<Memory[]> {
    const { entityId, agentId, roomId, worldId, tableName, unique, start, end } = params;

    if (!tableName) throw new Error('tableName is required');

    return this.withDatabase(async () => {
      const conditions = [eq(memoryTable.type, tableName)];

      if (start) {
        conditions.push(gte(memoryTable.createdAt, new Date(start)));
      }

      if (entityId) {
        conditions.push(eq(memoryTable.entityId, entityId));
      }

      if (roomId) {
        conditions.push(eq(memoryTable.roomId, roomId));
      }

      // Add worldId condition
      if (worldId) {
        conditions.push(eq(memoryTable.worldId, worldId));
      }

      if (end) {
        conditions.push(lte(memoryTable.createdAt, new Date(end)));
      }

      if (unique) {
        conditions.push(eq(memoryTable.unique, true));
      }

      if (agentId) {
        conditions.push(eq(memoryTable.agentId, agentId));
      }

      const query = this.db
        .select({
          memory: {
            id: memoryTable.id,
            type: memoryTable.type,
            createdAt: memoryTable.createdAt,
            content: memoryTable.content,
            entityId: memoryTable.entityId,
            agentId: memoryTable.agentId,
            roomId: memoryTable.roomId,
            unique: memoryTable.unique,
            metadata: memoryTable.metadata,
          },
          embedding: embeddingTable[this.embeddingDimension],
        })
        .from(memoryTable)
        .leftJoin(embeddingTable, eq(embeddingTable.memoryId, memoryTable.id))
        .where(and(...conditions))
        .orderBy(desc(memoryTable.createdAt));

      const rows = params.count ? await query.limit(params.count) : await query;

      return rows.map((row) => ({
        id: row.memory.id as UUID,
        type: row.memory.type,
        createdAt: row.memory.createdAt.getTime(),
        content:
          typeof row.memory.content === 'string'
            ? JSON.parse(row.memory.content)
            : row.memory.content,
        entityId: row.memory.entityId as UUID,
        agentId: row.memory.agentId as UUID,
        roomId: row.memory.roomId as UUID,
        unique: row.memory.unique,
        metadata: row.memory.metadata as MemoryMetadata,
        embedding: row.embedding ? Array.from(row.embedding) : undefined,
      }));
    });
  }

  /**
   * Asynchronously retrieves memories from the database based on the provided parameters.
   * @param {Object} params - The parameters for retrieving memories.
   * @param {UUID[]} params.roomIds - The IDs of the rooms to retrieve memories for.
   * @param {string} params.tableName - The name of the table to retrieve memories from.
   * @param {number} [params.limit] - The maximum number of memories to retrieve.
   * @returns {Promise<Memory[]>} A Promise that resolves to an array of memories.
   */
  async getMemoriesByRoomIds(params: {
    roomIds: UUID[];
    tableName: string;
    limit?: number;
  }): Promise<Memory[]> {
    return this.withDatabase(async () => {
      if (params.roomIds.length === 0) return [];

      const conditions = [
        eq(memoryTable.type, params.tableName),
        inArray(memoryTable.roomId, params.roomIds),
      ];

      conditions.push(eq(memoryTable.agentId, this.agentId));

      const query = this.db
        .select({
          id: memoryTable.id,
          type: memoryTable.type,
          createdAt: memoryTable.createdAt,
          content: memoryTable.content,
          entityId: memoryTable.entityId,
          agentId: memoryTable.agentId,
          roomId: memoryTable.roomId,
          unique: memoryTable.unique,
          metadata: memoryTable.metadata,
        })
        .from(memoryTable)
        .where(and(...conditions))
        .orderBy(desc(memoryTable.createdAt));

      const rows = params.limit ? await query.limit(params.limit) : await query;

      return rows.map((row) => ({
        id: row.id as UUID,
        createdAt: row.createdAt.getTime(),
        content: typeof row.content === 'string' ? JSON.parse(row.content) : row.content,
        entityId: row.entityId as UUID,
        agentId: row.agentId as UUID,
        roomId: row.roomId as UUID,
        unique: row.unique,
        metadata: row.metadata,
      })) as Memory[];
    });
  }

  /**
   * Asynchronously retrieves a memory by its unique identifier.
   * @param {UUID} id - The unique identifier of the memory to retrieve.
   * @returns {Promise<Memory | null>} A Promise that resolves to the memory if found, null otherwise.
   */
  async getMemoryById(id: UUID): Promise<Memory | null> {
    return this.withDatabase(async () => {
      const result = await this.db
        .select({
          memory: memoryTable,
          embedding: embeddingTable[this.embeddingDimension],
        })
        .from(memoryTable)
        .leftJoin(embeddingTable, eq(memoryTable.id, embeddingTable.memoryId))
        .where(eq(memoryTable.id, id))
        .limit(1);

      if (result.length === 0) return null;

      const row = result[0];
      return {
        id: row.memory.id as UUID,
        createdAt: row.memory.createdAt.getTime(),
        content:
          typeof row.memory.content === 'string'
            ? JSON.parse(row.memory.content)
            : row.memory.content,
        entityId: row.memory.entityId as UUID,
        agentId: row.memory.agentId as UUID,
        roomId: row.memory.roomId as UUID,
        unique: row.memory.unique,
        metadata: row.memory.metadata as MemoryMetadata,
        embedding: row.embedding ?? undefined,
      };
    });
  }

  /**
   * Asynchronously retrieves memories from the database based on the provided parameters.
   * @param {Object} params - The parameters for retrieving memories.
   * @param {UUID[]} params.memoryIds - The IDs of the memories to retrieve.
   * @param {string} [params.tableName] - The name of the table to retrieve memories from.
   * @returns {Promise<Memory[]>} A Promise that resolves to an array of memories.
   */
  async getMemoriesByIds(memoryIds: UUID[], tableName?: string): Promise<Memory[]> {
    return this.withDatabase(async () => {
      if (memoryIds.length === 0) return [];

      const conditions = [inArray(memoryTable.id, memoryIds)];

      if (tableName) {
        conditions.push(eq(memoryTable.type, tableName));
      }

      const rows = await this.db
        .select({
          memory: memoryTable,
          embedding: embeddingTable[this.embeddingDimension],
        })
        .from(memoryTable)
        .leftJoin(embeddingTable, eq(embeddingTable.memoryId, memoryTable.id))
        .where(and(...conditions))
        .orderBy(desc(memoryTable.createdAt));

      return rows.map((row) => ({
        id: row.memory.id as UUID,
        createdAt: row.memory.createdAt.getTime(),
        content:
          typeof row.memory.content === 'string'
            ? JSON.parse(row.memory.content)
            : row.memory.content,
        entityId: row.memory.entityId as UUID,
        agentId: row.memory.agentId as UUID,
        roomId: row.memory.roomId as UUID,
        unique: row.memory.unique,
        metadata: row.memory.metadata as MemoryMetadata,
        embedding: row.embedding ?? undefined,
      }));
    });
  }

  /**
   * Asynchronously retrieves cached embeddings from the database based on the provided parameters.
   * @param {Object} opts - The parameters for retrieving cached embeddings.
   * @param {string} opts.query_table_name - The name of the table to retrieve embeddings from.
   * @param {number} opts.query_threshold - The threshold for the levenshtein distance.
   * @param {string} opts.query_input - The input string to search for.
   * @param {string} opts.query_field_name - The name of the field to retrieve embeddings from.
   * @param {string} opts.query_field_sub_name - The name of the sub-field to retrieve embeddings from.
   * @param {number} opts.query_match_count - The maximum number of matches to retrieve.
   * @returns {Promise<{ embedding: number[]; levenshtein_score: number }[]>} A Promise that resolves to an array of cached embeddings.
   */
  async getCachedEmbeddings(opts: {
    query_table_name: string;
    query_threshold: number;
    query_input: string;
    query_field_name: string;
    query_field_sub_name: string;
    query_match_count: number;
  }): Promise<{ embedding: number[]; levenshtein_score: number }[]> {
    return this.withDatabase(async () => {
      try {
        const results = await (this.db as any).execute(sql`
                    WITH content_text AS (
                        SELECT
                            m.id,
                            COALESCE(
                                m.content->>${opts.query_field_sub_name},
                                ''
                            ) as content_text
                        FROM memories m
                        WHERE m.type = ${opts.query_table_name}
                            AND m.content->>${opts.query_field_sub_name} IS NOT NULL
                    ),
                    embedded_text AS (
                        SELECT
                            ct.content_text,
                            COALESCE(
                                e.dim_384,
                                e.dim_512,
                                e.dim_768,
                                e.dim_1024,
                                e.dim_1536,
                                e.dim_3072
                            ) as embedding
                        FROM content_text ct
                        LEFT JOIN embeddings e ON e.memory_id = ct.id
                        WHERE e.memory_id IS NOT NULL
                    )
                    SELECT
                        embedding,
                        levenshtein(${opts.query_input}, content_text) as levenshtein_score
                    FROM embedded_text
                    WHERE levenshtein(${opts.query_input}, content_text) <= ${opts.query_threshold}
                    ORDER BY levenshtein_score
                    LIMIT ${opts.query_match_count}
                `);

        return results.rows
          .map((row) => ({
            embedding: Array.isArray(row.embedding)
              ? row.embedding
              : typeof row.embedding === 'string'
                ? JSON.parse(row.embedding)
                : [],
            levenshtein_score: Number(row.levenshtein_score),
          }))
          .filter((row) => Array.isArray(row.embedding));
      } catch (error) {
        logger.error('Error in getCachedEmbeddings:', {
          error: error instanceof Error ? error.message : String(error),
          tableName: opts.query_table_name,
          fieldName: opts.query_field_name,
        });
        if (
          error instanceof Error &&
          error.message === 'levenshtein argument exceeds maximum length of 255 characters'
        ) {
          return [];
        }
        throw error;
      }
    });
  }

  /**
   * Asynchronously logs an event in the database.
   * @param {Object} params - The parameters for logging an event.
   * @param {Object} params.body - The body of the event to log.
   * @param {UUID} params.entityId - The ID of the entity associated with the event.
   * @param {UUID} params.roomId - The ID of the room associated with the event.
   * @param {string} params.type - The type of the event to log.
   * @returns {Promise<void>} A Promise that resolves when the event is logged.
   */
  async log(params: {
    body: { [key: string]: unknown };
    entityId: UUID;
    roomId: UUID;
    type: string;
  }): Promise<void> {
    return this.withDatabase(async () => {
      try {
        // Sanitize JSON body to prevent Unicode escape sequence errors
        const sanitizedBody = this.sanitizeJsonObject(params.body);

        // Serialize to JSON string first for an additional layer of protection
        // This ensures any problematic characters are properly escaped during JSON serialization
        const jsonString = JSON.stringify(sanitizedBody);

        await this.db.transaction(async (tx) => {
          await tx.insert(logTable).values({
            body: sql`${jsonString}::jsonb`,
            entityId: params.entityId,
            roomId: params.roomId,
            type: params.type,
          });
        });
      } catch (error) {
        logger.error('Failed to create log entry:', {
          error: error instanceof Error ? error.message : String(error),
          type: params.type,
          roomId: params.roomId,
          entityId: params.entityId,
        });
        throw error;
      }
    });
  }

  /**
   * Sanitizes a JSON object by replacing problematic Unicode escape sequences
   * that could cause errors during JSON serialization/storage
   *
   * @param value - The value to sanitize
   * @returns The sanitized value
   */
  private sanitizeJsonObject(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
    if (value === null || value === undefined) {
      return value;
    }

    if (typeof value === 'string') {
      // Handle multiple cases that can cause PostgreSQL/PgLite JSON parsing errors:
      // 1. Remove null bytes (U+0000) which are not allowed in PostgreSQL text fields
      // 2. Escape single backslashes that might be interpreted as escape sequences
      // 3. Fix broken Unicode escape sequences (\u not followed by 4 hex digits)
      return value
        .replace(/\u0000/g, '') // Remove null bytes
        .replace(/\\(?!["\\/bfnrtu])/g, '\\\\') // Escape single backslashes not part of valid escape sequences
        .replace(/\\u(?![0-9a-fA-F]{4})/g, '\\\\u'); // Fix malformed Unicode escape sequences
    }

    if (typeof value === 'object') {
      if (seen.has(value as object)) {
        return null;
      } else {
        seen.add(value as object);
      }

      if (Array.isArray(value)) {
        return value.map((item) => this.sanitizeJsonObject(item, seen));
      } else {
        const result: Record<string, unknown> = {};
        for (const [key, val] of Object.entries(value)) {
          // Also sanitize object keys
          const sanitizedKey =
            typeof key === 'string'
              ? key.replace(/\u0000/g, '').replace(/\\u(?![0-9a-fA-F]{4})/g, '\\\\u')
              : key;
          result[sanitizedKey] = this.sanitizeJsonObject(val, seen);
        }
        return result;
      }
    }

    return value;
  }

  /**
   * Asynchronously retrieves logs from the database based on the provided parameters.
   * @param {Object} params - The parameters for retrieving logs.
   * @param {UUID} params.entityId - The ID of the entity associated with the logs.
   * @param {UUID} [params.roomId] - The ID of the room associated with the logs.
   * @param {string} [params.type] - The type of the logs to retrieve.
   * @param {number} [params.count] - The maximum number of logs to retrieve.
   * @param {number} [params.offset] - The offset to retrieve logs from.
   * @returns {Promise<Log[]>} A Promise that resolves to an array of logs.
   */
  async getLogs(params: {
    entityId: UUID;
    roomId?: UUID;
    type?: string;
    count?: number;
    offset?: number;
  }): Promise<Log[]> {
    const { entityId, roomId, type, count, offset } = params;
    return this.withDatabase(async () => {
      const result = await this.db
        .select()
        .from(logTable)
        .where(
          and(
            eq(logTable.entityId, entityId),
            roomId ? eq(logTable.roomId, roomId) : undefined,
            type ? eq(logTable.type, type) : undefined
          )
        )
        .orderBy(desc(logTable.createdAt))
        .limit(count ?? 10)
        .offset(offset ?? 0);

      const logs = result.map((log) => ({
        ...log,
        id: log.id as UUID,
        entityId: log.entityId as UUID,
        roomId: log.roomId as UUID,
        body: log.body as { [key: string]: unknown },
        createdAt: new Date(log.createdAt),
      }));

      if (logs.length === 0) return [];

      return logs;
    });
  }

  /**
   * Asynchronously deletes a log from the database based on the provided parameters.
   * @param {UUID} logId - The ID of the log to delete.
   * @returns {Promise<void>} A Promise that resolves when the log is deleted.
   */
  async deleteLog(logId: UUID): Promise<void> {
    return this.withDatabase(async () => {
      await this.db.delete(logTable).where(eq(logTable.id, logId));
    });
  }

  /**
   * Asynchronously searches for memories in the database based on the provided parameters.
   * @param {Object} params - The parameters for searching for memories.
   * @param {string} params.tableName - The name of the table to search for memories in.
   * @param {number[]} params.embedding - The embedding to search for.
   * @param {number} [params.match_threshold] - The threshold for the cosine distance.
   * @param {number} [params.count] - The maximum number of memories to retrieve.
   * @param {boolean} [params.unique] - Whether to retrieve unique memories only.
   * @param {string} [params.query] - Optional query string for potential reranking.
   * @param {UUID} [params.roomId] - Optional room ID to filter by.
   * @param {UUID} [params.worldId] - Optional world ID to filter by.
   * @param {UUID} [params.entityId] - Optional entity ID to filter by.
   * @returns {Promise<Memory[]>} A Promise that resolves to an array of memories.
   */
  async searchMemories(params: {
    tableName: string;
    embedding: number[];
    match_threshold?: number;
    count?: number;
    unique?: boolean;
    query?: string;
    roomId?: UUID;
    worldId?: UUID;
    entityId?: UUID;
  }): Promise<Memory[]> {
    return await this.searchMemoriesByEmbedding(params.embedding, {
      match_threshold: params.match_threshold,
      count: params.count,
      // Pass direct scope fields down
      roomId: params.roomId,
      worldId: params.worldId,
      entityId: params.entityId,
      unique: params.unique,
      tableName: params.tableName,
    });
  }

  /**
   * Asynchronously searches for memories in the database based on the provided parameters.
   * @param {number[]} embedding - The embedding to search for.
   * @param {Object} params - The parameters for searching for memories.
   * @param {number} [params.match_threshold] - The threshold for the cosine distance.
   * @param {number} [params.count] - The maximum number of memories to retrieve.
   * @param {UUID} [params.roomId] - Optional room ID to filter by.
   * @param {UUID} [params.worldId] - Optional world ID to filter by.
   * @param {UUID} [params.entityId] - Optional entity ID to filter by.
   * @param {boolean} [params.unique] - Whether to retrieve unique memories only.
   * @param {string} [params.tableName] - The name of the table to search for memories in.
   * @returns {Promise<Memory[]>} A Promise that resolves to an array of memories.
   */
  async searchMemoriesByEmbedding(
    embedding: number[],
    params: {
      match_threshold?: number;
      count?: number;
      roomId?: UUID;
      worldId?: UUID;
      entityId?: UUID;
      unique?: boolean;
      tableName: string;
    }
  ): Promise<Memory[]> {
    return this.withDatabase(async () => {
      const cleanVector = embedding.map((n) => (Number.isFinite(n) ? Number(n.toFixed(6)) : 0));

      const similarity = sql<number>`1 - (${cosineDistance(
        embeddingTable[this.embeddingDimension],
        cleanVector
      )})`;

      const conditions = [eq(memoryTable.type, params.tableName)];

      if (params.unique) {
        conditions.push(eq(memoryTable.unique, true));
      }

      conditions.push(eq(memoryTable.agentId, this.agentId));

      // Add filters based on direct params
      if (params.roomId) {
        conditions.push(eq(memoryTable.roomId, params.roomId));
      }
      if (params.worldId) {
        conditions.push(eq(memoryTable.worldId, params.worldId));
      }
      if (params.entityId) {
        conditions.push(eq(memoryTable.entityId, params.entityId));
      }

      if (params.match_threshold) {
        conditions.push(gte(similarity, params.match_threshold));
      }

      const results = await this.db
        .select({
          memory: memoryTable,
          similarity,
          embedding: embeddingTable[this.embeddingDimension],
        })
        .from(embeddingTable)
        .innerJoin(memoryTable, eq(memoryTable.id, embeddingTable.memoryId))
        .where(and(...conditions))
        .orderBy(desc(similarity))
        .limit(params.count ?? 10);

      return results.map((row) => ({
        id: row.memory.id as UUID,
        type: row.memory.type,
        createdAt: row.memory.createdAt.getTime(),
        content:
          typeof row.memory.content === 'string'
            ? JSON.parse(row.memory.content)
            : row.memory.content,
        entityId: row.memory.entityId as UUID,
        agentId: row.memory.agentId as UUID,
        roomId: row.memory.roomId as UUID,
        worldId: row.memory.worldId as UUID | undefined, // Include worldId
        unique: row.memory.unique,
        metadata: row.memory.metadata as MemoryMetadata,
        embedding: row.embedding ?? undefined,
        similarity: row.similarity,
      }));
    });
  }

  /**
   * Asynchronously creates a new memory in the database.
   * @param {Memory & { metadata?: MemoryMetadata }} memory - The memory object to create.
   * @param {string} tableName - The name of the table to create the memory in.
   * @returns {Promise<UUID>} A Promise that resolves to the ID of the created memory.
   */
  async createMemory(
    memory: Memory & { metadata?: MemoryMetadata },
    tableName: string
  ): Promise<UUID> {
    logger.debug('DrizzleAdapter createMemory:', {
      memoryId: memory.id,
      embeddingLength: memory.embedding?.length,
      contentLength: memory.content?.text?.length,
    });

    const memoryId = memory.id ?? (v4() as UUID);

    const existing = await this.getMemoryById(memoryId);
    if (existing) {
      logger.debug('Memory already exists, skipping creation:', {
        memoryId,
      });
      return memoryId;
    }

    let isUnique = true;
    if (memory.embedding && Array.isArray(memory.embedding)) {
      const similarMemories = await this.searchMemoriesByEmbedding(memory.embedding, {
        tableName,
        // Use the scope fields from the memory object for similarity check
        roomId: memory.roomId,
        worldId: memory.worldId,
        entityId: memory.entityId,
        match_threshold: 0.95,
        count: 1,
      });
      isUnique = similarMemories.length === 0;
    }

    const contentToInsert =
      typeof memory.content === 'string' ? JSON.parse(memory.content) : memory.content;

    await this.db.transaction(async (tx) => {
      await tx.insert(memoryTable).values([
        {
          id: memoryId,
          type: tableName,
          content: sql`${contentToInsert}::jsonb`,
          metadata: sql`${memory.metadata || {}}::jsonb`,
          entityId: memory.entityId,
          roomId: memory.roomId,
          worldId: memory.worldId, // Include worldId
          agentId: memory.agentId || this.agentId,
          unique: memory.unique ?? isUnique,
          createdAt: memory.createdAt ? new Date(memory.createdAt) : new Date(),
        },
      ]);

      if (memory.embedding && Array.isArray(memory.embedding)) {
        const embeddingValues: Record<string, unknown> = {
          id: v4(),
          memoryId: memoryId,
          createdAt: memory.createdAt ? new Date(memory.createdAt) : new Date(),
        };

        const cleanVector = memory.embedding.map((n) =>
          Number.isFinite(n) ? Number(n.toFixed(6)) : 0
        );

        embeddingValues[this.embeddingDimension] = cleanVector;

        await tx.insert(embeddingTable).values([embeddingValues]);
      }
    });

    return memoryId;
  }

  /**
   * Updates an existing memory in the database.
   * @param memory The memory object with updated content and optional embedding
   * @returns Promise resolving to boolean indicating success
   */
  async updateMemory(
    memory: Partial<Memory> & { id: UUID; metadata?: MemoryMetadata }
  ): Promise<boolean> {
    return this.withDatabase(async () => {
      try {
        logger.debug('Updating memory:', {
          memoryId: memory.id,
          hasEmbedding: !!memory.embedding,
        });

        await this.db.transaction(async (tx) => {
          // Update memory content if provided
          if (memory.content) {
            const contentToUpdate =
              typeof memory.content === 'string' ? JSON.parse(memory.content) : memory.content;

            await tx
              .update(memoryTable)
              .set({
                content: sql`${contentToUpdate}::jsonb`,
                ...(memory.metadata && { metadata: sql`${memory.metadata}::jsonb` }),
              })
              .where(eq(memoryTable.id, memory.id));
          } else if (memory.metadata) {
            // Update only metadata if content is not provided
            await tx
              .update(memoryTable)
              .set({
                metadata: sql`${memory.metadata}::jsonb`,
              })
              .where(eq(memoryTable.id, memory.id));
          }

          // Update embedding if provided
          if (memory.embedding && Array.isArray(memory.embedding)) {
            const cleanVector = memory.embedding.map((n) =>
              Number.isFinite(n) ? Number(n.toFixed(6)) : 0
            );

            // Check if embedding exists
            const existingEmbedding = await tx
              .select({ id: embeddingTable.id })
              .from(embeddingTable)
              .where(eq(embeddingTable.memoryId, memory.id))
              .limit(1);

            if (existingEmbedding.length > 0) {
              // Update existing embedding
              const updateValues: Record<string, unknown> = {};
              updateValues[this.embeddingDimension] = cleanVector;

              await tx
                .update(embeddingTable)
                .set(updateValues)
                .where(eq(embeddingTable.memoryId, memory.id));
            } else {
              // Create new embedding
              const embeddingValues: Record<string, unknown> = {
                id: v4(),
                memoryId: memory.id,
              };
              embeddingValues[this.embeddingDimension] = cleanVector;

              await tx.insert(embeddingTable).values([embeddingValues]);
            }
          }
        });

        logger.debug('Memory updated successfully:', {
          memoryId: memory.id,
        });
        return true;
      } catch (error) {
        logger.error('Error updating memory:', {
          error: error instanceof Error ? error.message : String(error),
          memoryId: memory.id,
        });
        return false;
      }
    });
  }

  /**
   * Asynchronously deletes a memory from the database based on the provided parameters.
   * @param {UUID} memoryId - The ID of the memory to delete.
   * @returns {Promise<void>} A Promise that resolves when the memory is deleted.
   */
  async deleteMemory(memoryId: UUID): Promise<void> {
    return this.withDatabase(async () => {
      await this.db.transaction(async (tx) => {
        // See if there are any fragments that we need to delete
        await this.deleteMemoryFragments(tx, memoryId);

        // Then delete the embedding for the main memory
        await tx.delete(embeddingTable).where(eq(embeddingTable.memoryId, memoryId));

        // Finally delete the memory itself
        await tx.delete(memoryTable).where(eq(memoryTable.id, memoryId));
      });

      logger.debug('Memory and related fragments removed successfully:', {
        memoryId,
      });
    });
  }

  /**
   * Asynchronously deletes multiple memories from the database in a single batch operation.
   * @param {UUID[]} memoryIds - An array of UUIDs of the memories to delete.
   * @returns {Promise<void>} A Promise that resolves when all memories are deleted.
   */
  async deleteManyMemories(memoryIds: UUID[]): Promise<void> {
    if (memoryIds.length === 0) {
      return;
    }

    return this.withDatabase(async () => {
      await this.db.transaction(async (tx) => {
        // Process in smaller batches to avoid query size limits
        const BATCH_SIZE = 100;
        for (let i = 0; i < memoryIds.length; i += BATCH_SIZE) {
          const batch = memoryIds.slice(i, i + BATCH_SIZE);

          // Delete any fragments for document memories in this batch
          await Promise.all(
            batch.map(async (memoryId) => {
              await this.deleteMemoryFragments(tx, memoryId);
            })
          );

          // Delete embeddings for the batch
          await tx.delete(embeddingTable).where(inArray(embeddingTable.memoryId, batch));

          // Delete the memories themselves
          await tx.delete(memoryTable).where(inArray(memoryTable.id, batch));
        }
      });

      logger.debug('Batch memory deletion completed successfully:', {
        count: memoryIds.length,
      });
    });
  }

  /**
   * Deletes all memory fragments that reference a specific document memory
   * @param tx The database transaction
   * @param documentId The UUID of the document memory whose fragments should be deleted
   * @private
   */
  private async deleteMemoryFragments(tx: any, documentId: UUID): Promise<void> {
    const fragmentsToDelete = await this.getMemoryFragments(tx, documentId);

    if (fragmentsToDelete.length > 0) {
      const fragmentIds = fragmentsToDelete.map((f) => f.id) as UUID[];

      // Delete embeddings for fragments
      await tx.delete(embeddingTable).where(inArray(embeddingTable.memoryId, fragmentIds));

      // Delete the fragments
      await tx.delete(memoryTable).where(inArray(memoryTable.id, fragmentIds));

      logger.debug('Deleted related fragments:', {
        documentId,
        fragmentCount: fragmentsToDelete.length,
      });
    }
  }

  /**
   * Retrieves all memory fragments that reference a specific document memory
   * @param tx The database transaction
   * @param documentId The UUID of the document memory whose fragments should be retrieved
   * @returns An array of memory fragments
   * @private
   */
  private async getMemoryFragments(tx: any, documentId: UUID): Promise<{ id: UUID }[]> {
    const fragments = await tx
      .select({ id: memoryTable.id })
      .from(memoryTable)
      .where(
        and(
          eq(memoryTable.agentId, this.agentId),
          sql`${memoryTable.metadata}->>'documentId' = ${documentId}`
        )
      );

    return fragments.map((f) => ({ id: f.id as UUID }));
  }

  /**
   * Asynchronously deletes all memories from the database based on the provided parameters.
   * @param {UUID} roomId - The ID of the room to delete memories from.
   * @param {string} tableName - The name of the table to delete memories from.
   * @returns {Promise<void>} A Promise that resolves when the memories are deleted.
   */
  async deleteAllMemories(roomId: UUID, tableName: string): Promise<void> {
    return this.withDatabase(async () => {
      await this.db.transaction(async (tx) => {
        // 1) fetch all memory IDs for this room + table
        const rows = await tx
          .select({ id: memoryTable.id })
          .from(memoryTable)
          .where(and(eq(memoryTable.roomId, roomId), eq(memoryTable.type, tableName)));

        const ids = rows.map((r) => r.id);
        logger.debug('[deleteAllMemories] memory IDs to delete:', { roomId, tableName, ids });

        if (ids.length === 0) {
          return;
        }

        // 2) delete any fragments for "document" memories & their embeddings
        await Promise.all(
          ids.map(async (memoryId) => {
            await this.deleteMemoryFragments(tx, memoryId);
            await tx.delete(embeddingTable).where(eq(embeddingTable.memoryId, memoryId));
          })
        );

        // 3) delete the memories themselves
        await tx
          .delete(memoryTable)
          .where(and(eq(memoryTable.roomId, roomId), eq(memoryTable.type, tableName)));
      });

      logger.debug('All memories removed successfully:', { roomId, tableName });
    });
  }

  /**
   * Asynchronously counts the number of memories in the database based on the provided parameters.
   * @param {UUID} roomId - The ID of the room to count memories in.
   * @param {boolean} [unique] - Whether to count unique memories only.
   * @param {string} [tableName] - The name of the table to count memories in.
   * @returns {Promise<number>} A Promise that resolves to the number of memories.
   */
  async countMemories(roomId: UUID, unique = true, tableName = ''): Promise<number> {
    if (!tableName) throw new Error('tableName is required');

    return this.withDatabase(async () => {
      const conditions = [eq(memoryTable.roomId, roomId), eq(memoryTable.type, tableName)];

      if (unique) {
        conditions.push(eq(memoryTable.unique, true));
      }

      const result = await this.db
        .select({ count: sql<number>`count(*)` })
        .from(memoryTable)
        .where(and(...conditions));

      return Number(result[0]?.count ?? 0);
    });
  }

  /**
   * Asynchronously retrieves rooms from the database based on the provided parameters.
   * @param {UUID[]} roomIds - The IDs of the rooms to retrieve.
   * @returns {Promise<Room[] | null>} A Promise that resolves to the rooms if found, null otherwise.
   */
  async getRoomsByIds(roomIds: UUID[]): Promise<Room[] | null> {
    return this.withDatabase(async () => {
      const result = await this.db
        .select({
          id: roomTable.id,
          name: roomTable.name, // Added name
          channelId: roomTable.channelId,
          agentId: roomTable.agentId,
          serverId: roomTable.serverId,
          worldId: roomTable.worldId,
          type: roomTable.type,
          source: roomTable.source,
          metadata: roomTable.metadata, // Added metadata
        })
        .from(roomTable)
        .where(and(inArray(roomTable.id, roomIds), eq(roomTable.agentId, this.agentId)));

      // Map the result to properly typed Room objects
      const rooms = result.map((room) => ({
        ...room,
        id: room.id as UUID,
        name: room.name ?? undefined,
        agentId: room.agentId as UUID,
        serverId: room.serverId as UUID,
        worldId: room.worldId as UUID,
        channelId: room.channelId as UUID,
        type: room.type as ChannelType,
        metadata: room.metadata as RoomMetadata,
      }));

      return rooms;
    });
  }

  /**
   * Asynchronously retrieves all rooms from the database based on the provided parameters.
   * @param {UUID} worldId - The ID of the world to retrieve rooms from.
   * @returns {Promise<Room[]>} A Promise that resolves to an array of rooms.
   */
  async getRoomsByWorld(worldId: UUID): Promise<Room[]> {
    return this.withDatabase(async () => {
      const result = await this.db.select().from(roomTable).where(eq(roomTable.worldId, worldId));
      const rooms = result.map((room) => ({
        ...room,
        id: room.id as UUID,
        name: room.name ?? undefined,
        agentId: room.agentId as UUID,
        serverId: room.serverId as UUID,
        worldId: room.worldId as UUID,
        channelId: room.channelId as UUID,
        type: room.type as ChannelType,
        metadata: room.metadata as RoomMetadata,
      }));
      return rooms;
    });
  }

  /**
   * Asynchronously updates a room in the database based on the provided parameters.
   * @param {Room} room - The room object to update.
   * @returns {Promise<void>} A Promise that resolves when the room is updated.
   */
  async updateRoom(room: Room): Promise<void> {
    return this.withDatabase(async () => {
      await this.db
        .update(roomTable)
        .set({ ...room, agentId: this.agentId })
        .where(eq(roomTable.id, room.id));
    });
  }

  /**
   * Asynchronously creates a new room in the database based on the provided parameters.
   * @param {Room} room - The room object to create.
   * @returns {Promise<UUID>} A Promise that resolves to the ID of the created room.
   */
  async createRooms(rooms: Room[]): Promise<UUID[]> {
    return this.withDatabase(async () => {
      const roomsWithIds = rooms.map((room) => ({
        ...room,
        agentId: this.agentId,
        id: room.id || v4(), // ensure each room has a unique ID
      }));

      const insertedRooms = await this.db
        .insert(roomTable)
        .values(roomsWithIds)
        .onConflictDoNothing()
        .returning();
      const insertedIds = insertedRooms.map((r) => r.id as UUID);
      return insertedIds;
    });
  }

  /**
   * Asynchronously deletes a room from the database based on the provided parameters.
   * @param {UUID} roomId - The ID of the room to delete.
   * @returns {Promise<void>} A Promise that resolves when the room is deleted.
   */
  async deleteRoom(roomId: UUID): Promise<void> {
    if (!roomId) throw new Error('Room ID is required');
    return this.withDatabase(async () => {
      await this.db.transaction(async (tx) => {
        await tx.delete(roomTable).where(eq(roomTable.id, roomId));
      });
    });
  }

  /**
   * Asynchronously retrieves all rooms for a participant from the database based on the provided parameters.
   * @param {UUID} entityId - The ID of the entity to retrieve rooms for.
   * @returns {Promise<UUID[]>} A Promise that resolves to an array of room IDs.
   */
  async getRoomsForParticipant(entityId: UUID): Promise<UUID[]> {
    console.log('getRoomsForParticipant', entityId);
    return this.withDatabase(async () => {
      const result = await this.db
        .select({ roomId: participantTable.roomId })
        .from(participantTable)
        .innerJoin(roomTable, eq(participantTable.roomId, roomTable.id))
        .where(and(eq(participantTable.entityId, entityId), eq(roomTable.agentId, this.agentId)));

      return result.map((row) => row.roomId as UUID);
    });
  }

  /**
   * Asynchronously retrieves all rooms for a list of participants from the database based on the provided parameters.
   * @param {UUID[]} entityIds - The IDs of the entities to retrieve rooms for.
   * @returns {Promise<UUID[]>} A Promise that resolves to an array of room IDs.
   */
  async getRoomsForParticipants(entityIds: UUID[]): Promise<UUID[]> {
    return this.withDatabase(async () => {
      const result = await this.db
        .selectDistinct({ roomId: participantTable.roomId })
        .from(participantTable)
        .innerJoin(roomTable, eq(participantTable.roomId, roomTable.id))
        .where(
          and(inArray(participantTable.entityId, entityIds), eq(roomTable.agentId, this.agentId))
        );

      return result.map((row) => row.roomId as UUID);
    });
  }

  /**
   * Asynchronously adds a participant to a room in the database based on the provided parameters.
   * @param {UUID} entityId - The ID of the entity to add to the room.
   * @param {UUID} roomId - The ID of the room to add the entity to.
   * @returns {Promise<boolean>} A Promise that resolves to a boolean indicating whether the participant was added successfully.
   */
  async addParticipant(entityId: UUID, roomId: UUID): Promise<boolean> {
    return this.withDatabase(async () => {
      try {
        await this.db
          .insert(participantTable)
          .values({
            entityId,
            roomId,
            agentId: this.agentId,
          })
          .onConflictDoNothing();
        return true;
      } catch (error) {
        logger.error('Error adding participant', {
          error: error instanceof Error ? error.message : String(error),
          entityId,
          roomId,
          agentId: this.agentId,
        });
        return false;
      }
    });
  }

  async addParticipantsRoom(entityIds: UUID[], roomId: UUID): Promise<boolean> {
    return this.withDatabase(async () => {
      try {
        const values = entityIds.map((id) => ({
          entityId: id,
          roomId,
          agentId: this.agentId,
        }));
        await this.db.insert(participantTable).values(values).onConflictDoNothing().execute();
        logger.debug(entityIds.length, 'Entities linked successfully');
        return true;
      } catch (error) {
        logger.error('Error adding participants', {
          error: error instanceof Error ? error.message : String(error),
          entityIdSample: entityIds[0],
          roomId,
          agentId: this.agentId,
        });
        return false;
      }
    });
  }

  /**
   * Asynchronously removes a participant from a room in the database based on the provided parameters.
   * @param {UUID} entityId - The ID of the entity to remove from the room.
   * @param {UUID} roomId - The ID of the room to remove the entity from.
   * @returns {Promise<boolean>} A Promise that resolves to a boolean indicating whether the participant was removed successfully.
   */
  async removeParticipant(entityId: UUID, roomId: UUID): Promise<boolean> {
    return this.withDatabase(async () => {
      try {
        const result = await this.db.transaction(async (tx) => {
          return await tx
            .delete(participantTable)
            .where(
              and(eq(participantTable.entityId, entityId), eq(participantTable.roomId, roomId))
            )
            .returning();
        });

        const removed = result.length > 0;
        logger.debug(`Participant ${removed ? 'removed' : 'not found'}:`, {
          entityId,
          roomId,
          removed,
        });

        return removed;
      } catch (error) {
        logger.error('Failed to remove participant:', {
          error: error instanceof Error ? error.message : String(error),
          entityId,
          roomId,
        });
        return false;
      }
    });
  }

  /**
   * Asynchronously retrieves all participants for an entity from the database based on the provided parameters.
   * @param {UUID} entityId - The ID of the entity to retrieve participants for.
   * @returns {Promise<Participant[]>} A Promise that resolves to an array of participants.
   */
  async getParticipantsForEntity(entityId: UUID): Promise<Participant[]> {
    return this.withDatabase(async () => {
      const result = await this.db
        .select({
          id: participantTable.id,
          entityId: participantTable.entityId,
          roomId: participantTable.roomId,
        })
        .from(participantTable)
        .where(eq(participantTable.entityId, entityId));

      const entities = await this.getEntityByIds([entityId]);

      if (!entities || !entities.length) {
        return [];
      }

      return result.map((row) => ({
        id: row.id as UUID,
        entity: entities[0],
      }));
    });
  }

  /**
   * Asynchronously retrieves all participants for a room from the database based on the provided parameters.
   * @param {UUID} roomId - The ID of the room to retrieve participants for.
   * @returns {Promise<UUID[]>} A Promise that resolves to an array of entity IDs.
   */
  async getParticipantsForRoom(roomId: UUID): Promise<UUID[]> {
    return this.withDatabase(async () => {
      const result = await this.db
        .select({ entityId: participantTable.entityId })
        .from(participantTable)
        .where(eq(participantTable.roomId, roomId));

      return result.map((row) => row.entityId as UUID);
    });
  }

  /**
   * Asynchronously retrieves the user state for a participant in a room from the database based on the provided parameters.
   * @param {UUID} roomId - The ID of the room to retrieve the participant's user state for.
   * @param {UUID} entityId - The ID of the entity to retrieve the user state for.
   * @returns {Promise<"FOLLOWED" | "MUTED" | null>} A Promise that resolves to the participant's user state.
   */
  async getParticipantUserState(
    roomId: UUID,
    entityId: UUID
  ): Promise<'FOLLOWED' | 'MUTED' | null> {
    return this.withDatabase(async () => {
      const result = await this.db
        .select({ roomState: participantTable.roomState })
        .from(participantTable)
        .where(
          and(
            eq(participantTable.roomId, roomId),
            eq(participantTable.entityId, entityId),
            eq(participantTable.agentId, this.agentId)
          )
        )
        .limit(1);

      return (result[0]?.roomState as 'FOLLOWED' | 'MUTED' | null) ?? null;
    });
  }

  /**
   * Asynchronously sets the user state for a participant in a room in the database based on the provided parameters.
   * @param {UUID} roomId - The ID of the room to set the participant's user state for.
   * @param {UUID} entityId - The ID of the entity to set the user state for.
   * @param {string} state - The state to set the participant's user state to.
   * @returns {Promise<void>} A Promise that resolves when the participant's user state is set.
   */
  async setParticipantUserState(
    roomId: UUID,
    entityId: UUID,
    state: 'FOLLOWED' | 'MUTED' | null
  ): Promise<void> {
    return this.withDatabase(async () => {
      try {
        await this.db.transaction(async (tx) => {
          await tx
            .update(participantTable)
            .set({ roomState: state })
            .where(
              and(
                eq(participantTable.roomId, roomId),
                eq(participantTable.entityId, entityId),
                eq(participantTable.agentId, this.agentId)
              )
            );
        });
      } catch (error) {
        logger.error('Failed to set participant user state:', {
          roomId,
          entityId,
          state,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    });
  }

  /**
   * Asynchronously creates a new relationship in the database based on the provided parameters.
   * @param {Object} params - The parameters for creating a new relationship.
   * @param {UUID} params.sourceEntityId - The ID of the source entity.
   * @param {UUID} params.targetEntityId - The ID of the target entity.
   * @param {string[]} [params.tags] - The tags for the relationship.
   * @param {Object} [params.metadata] - The metadata for the relationship.
   * @returns {Promise<boolean>} A Promise that resolves to a boolean indicating whether the relationship was created successfully.
   */
  async createRelationship(params: {
    sourceEntityId: UUID;
    targetEntityId: UUID;
    tags?: string[];
    metadata?: { [key: string]: unknown };
  }): Promise<boolean> {
    return this.withDatabase(async () => {
      const id = v4();
      const saveParams = {
        id,
        sourceEntityId: params.sourceEntityId,
        targetEntityId: params.targetEntityId,
        agentId: this.agentId,
        tags: params.tags || [],
        metadata: params.metadata || {},
      };
      try {
        await this.db.insert(relationshipTable).values(saveParams);
        return true;
      } catch (error) {
        logger.error('Error creating relationship:', {
          error: error instanceof Error ? error.message : String(error),
          saveParams,
        });
        return false;
      }
    });
  }

  /**
   * Asynchronously updates an existing relationship in the database based on the provided parameters.
   * @param {Relationship} relationship - The relationship object to update.
   * @returns {Promise<void>} A Promise that resolves when the relationship is updated.
   */
  async updateRelationship(relationship: Relationship): Promise<void> {
    return this.withDatabase(async () => {
      try {
        await this.db
          .update(relationshipTable)
          .set({
            tags: relationship.tags || [],
            metadata: relationship.metadata || {},
          })
          .where(eq(relationshipTable.id, relationship.id));
      } catch (error) {
        logger.error('Error updating relationship:', {
          error: error instanceof Error ? error.message : String(error),
          relationship,
        });
        throw error;
      }
    });
  }

  /**
   * Asynchronously retrieves a relationship from the database based on the provided parameters.
   * @param {Object} params - The parameters for retrieving a relationship.
   * @param {UUID} params.sourceEntityId - The ID of the source entity.
   * @param {UUID} params.targetEntityId - The ID of the target entity.
   * @returns {Promise<Relationship | null>} A Promise that resolves to the relationship if found, null otherwise.
   */
  async getRelationship(params: {
    sourceEntityId: UUID;
    targetEntityId: UUID;
  }): Promise<Relationship | null> {
    return this.withDatabase(async () => {
      const { sourceEntityId, targetEntityId } = params;
      const result = await this.db
        .select()
        .from(relationshipTable)
        .where(
          and(
            eq(relationshipTable.sourceEntityId, sourceEntityId),
            eq(relationshipTable.targetEntityId, targetEntityId)
          )
        );
      if (result.length === 0) return null;
      const relationship = result[0];
      return {
        ...relationship,
        id: relationship.id as UUID,
        sourceEntityId: relationship.sourceEntityId as UUID,
        targetEntityId: relationship.targetEntityId as UUID,
        agentId: relationship.agentId as UUID,
        tags: relationship.tags ?? [],
        metadata: (relationship.metadata as { [key: string]: unknown }) ?? {},
        createdAt: relationship.createdAt.toISOString(),
      };
    });
  }

  /**
   * Asynchronously retrieves relationships from the database based on the provided parameters.
   * @param {Object} params - The parameters for retrieving relationships.
   * @param {UUID} params.entityId - The ID of the entity to retrieve relationships for.
   * @param {string[]} [params.tags] - The tags to filter relationships by.
   * @returns {Promise<Relationship[]>} A Promise that resolves to an array of relationships.
   */
  async getRelationships(params: { entityId: UUID; tags?: string[] }): Promise<Relationship[]> {
    return this.withDatabase(async () => {
      const { entityId, tags } = params;

      let query: SQL;

      if (tags && tags.length > 0) {
        query = sql`
          SELECT * FROM ${relationshipTable}
          WHERE (${relationshipTable.sourceEntityId} = ${entityId} OR ${relationshipTable.targetEntityId} = ${entityId})
          AND ${relationshipTable.tags} && CAST(ARRAY[${sql.join(tags, sql`, `)}] AS text[])
        `;
      } else {
        query = sql`
          SELECT * FROM ${relationshipTable}
          WHERE ${relationshipTable.sourceEntityId} = ${entityId} OR ${relationshipTable.targetEntityId} = ${entityId}
        `;
      }

      const result = await this.db.execute(query);

      return result.rows.map((relationship: any) => ({
        ...relationship,
        id: relationship.id as UUID,
        sourceEntityId: relationship.sourceEntityId as UUID,
        targetEntityId: relationship.targetEntityId as UUID,
        agentId: relationship.agentId as UUID,
        tags: relationship.tags ?? [],
        metadata: (relationship.metadata as { [key: string]: unknown }) ?? {},
        createdAt: relationship.createdAt
          ? relationship.createdAt instanceof Date
            ? relationship.createdAt.toISOString()
            : new Date(relationship.createdAt).toISOString()
          : new Date().toISOString(),
      }));
    });
  }

  /**
   * Asynchronously retrieves a cache value from the database based on the provided key.
   * @param {string} key - The key to retrieve the cache value for.
   * @returns {Promise<T | undefined>} A Promise that resolves to the cache value if found, undefined otherwise.
   */
  async getCache<T>(key: string): Promise<T | undefined> {
    return this.withDatabase(async () => {
      try {
        const result = await this.db
          .select({ value: cacheTable.value })
          .from(cacheTable)
          .where(and(eq(cacheTable.agentId, this.agentId), eq(cacheTable.key, key)))
          .limit(1);

        if (result && result.length > 0 && result[0]) {
          return result[0].value as T | undefined;
        }

        return undefined;
      } catch (error) {
        logger.error('Error fetching cache', {
          error: error instanceof Error ? error.message : String(error),
          key: key,
          agentId: this.agentId,
        });
        return undefined;
      }
    });
  }

  /**
   * Asynchronously sets a cache value in the database based on the provided key and value.
   * @param {string} key - The key to set the cache value for.
   * @param {T} value - The value to set in the cache.
   * @returns {Promise<boolean>} A Promise that resolves to a boolean indicating whether the cache value was set successfully.
   */
  async setCache<T>(key: string, value: T): Promise<boolean> {
    return this.withDatabase(async () => {
      try {
        await this.db
          .insert(cacheTable)
          .values({
            key: key,
            agentId: this.agentId,
            value: value,
          })
          .onConflictDoUpdate({
            target: [cacheTable.key, cacheTable.agentId],
            set: {
              value: value,
            },
          });

        return true;
      } catch (error) {
        logger.error('Error setting cache', {
          error: error instanceof Error ? error.message : String(error),
          key: key,
          agentId: this.agentId,
        });
        return false;
      }
    });
  }

  /**
   * Asynchronously deletes a cache value from the database based on the provided key.
   * @param {string} key - The key to delete the cache value for.
   * @returns {Promise<boolean>} A Promise that resolves to a boolean indicating whether the cache value was deleted successfully.
   */
  async deleteCache(key: string): Promise<boolean> {
    return this.withDatabase(async () => {
      try {
        await this.db.transaction(async (tx) => {
          await tx
            .delete(cacheTable)
            .where(and(eq(cacheTable.agentId, this.agentId), eq(cacheTable.key, key)));
        });
        return true;
      } catch (error) {
        logger.error('Error deleting cache', {
          error: error instanceof Error ? error.message : String(error),
          key: key,
          agentId: this.agentId,
        });
        return false;
      }
    });
  }

  /**
   * Asynchronously creates a new world in the database based on the provided parameters.
   * @param {World} world - The world object to create.
   * @returns {Promise<UUID>} A Promise that resolves to the ID of the created world.
   */
  async createWorld(world: World): Promise<UUID> {
    return this.withDatabase(async () => {
      const newWorldId = world.id || v4();
      await this.db.insert(worldTable).values({
        ...world,
        id: newWorldId,
        name: world.name || '',
      });
      return newWorldId;
    });
  }

  /**
   * Asynchronously retrieves a world from the database based on the provided parameters.
   * @param {UUID} id - The ID of the world to retrieve.
   * @returns {Promise<World | null>} A Promise that resolves to the world if found, null otherwise.
   */
  async getWorld(id: UUID): Promise<World | null> {
    return this.withDatabase(async () => {
      const result = await this.db.select().from(worldTable).where(eq(worldTable.id, id));
      return result.length > 0 ? (result[0] as World) : null;
    });
  }

  /**
   * Asynchronously retrieves all worlds from the database based on the provided parameters.
   * @returns {Promise<World[]>} A Promise that resolves to an array of worlds.
   */
  async getAllWorlds(): Promise<World[]> {
    return this.withDatabase(async () => {
      const result = await this.db
        .select()
        .from(worldTable)
        .where(eq(worldTable.agentId, this.agentId));
      return result as World[];
    });
  }

  /**
   * Asynchronously updates an existing world in the database based on the provided parameters.
   * @param {World} world - The world object to update.
   * @returns {Promise<void>} A Promise that resolves when the world is updated.
   */
  async updateWorld(world: World): Promise<void> {
    return this.withDatabase(async () => {
      await this.db.update(worldTable).set(world).where(eq(worldTable.id, world.id));
    });
  }

  /**
   * Asynchronously removes a world from the database based on the provided parameters.
   * @param {UUID} id - The ID of the world to remove.
   * @returns {Promise<void>} A Promise that resolves when the world is removed.
   */
  async removeWorld(id: UUID): Promise<void> {
    return this.withDatabase(async () => {
      await this.db.delete(worldTable).where(eq(worldTable.id, id));
    });
  }

  /**
   * Asynchronously creates a new task in the database based on the provided parameters.
   * @param {Task} task - The task object to create.
   * @returns {Promise<UUID>} A Promise that resolves to the ID of the created task.
   */
  async createTask(task: Task): Promise<UUID> {
    if (!task.worldId) {
      throw new Error('worldId is required');
    }
    return this.withRetry(async () => {
      return this.withDatabase(async () => {
        const now = new Date();
        const metadata = task.metadata || {};

        const values = {
          id: task.id as UUID,
          name: task.name,
          description: task.description,
          roomId: task.roomId as UUID,
          worldId: task.worldId as UUID,
          tags: task.tags,
          metadata: metadata,
          createdAt: now,
          updatedAt: now,
          agentId: this.agentId as UUID,
        };

        const result = await this.db.insert(taskTable).values(values).returning();

        return result[0].id as UUID;
      });
    });
  }

  /**
   * Asynchronously retrieves tasks based on specified parameters.
   * @param params Object containing optional roomId, tags, and entityId to filter tasks
   * @returns Promise resolving to an array of Task objects
   */
  async getTasks(params: {
    roomId?: UUID;
    tags?: string[];
    entityId?: UUID; // Added entityId parameter
  }): Promise<Task[]> {
    return this.withRetry(async () => {
      return this.withDatabase(async () => {
        const result = await this.db
          .select()
          .from(taskTable)
          .where(
            and(
              eq(taskTable.agentId, this.agentId),
              ...(params.roomId ? [eq(taskTable.roomId, params.roomId)] : []),
              ...(params.tags && params.tags.length > 0
                ? [
                    sql`${taskTable.tags} @> ARRAY[${sql.raw(
                      params.tags.map((t) => `'${t.replace(/'/g, "''")}'`).join(', ')
                    )}]::text[]`,
                  ]
                : [])
            )
          );

        return result.map((row) => ({
          id: row.id as UUID,
          name: row.name,
          description: row.description ?? '',
          roomId: row.roomId as UUID,
          worldId: row.worldId as UUID,
          tags: row.tags || [],
          metadata: row.metadata as TaskMetadata,
        }));
      });
    });
  }

  /**
   * Asynchronously retrieves a specific task by its name.
   * @param name The name of the task to retrieve
   * @returns Promise resolving to the Task object if found, null otherwise
   */
  async getTasksByName(name: string): Promise<Task[]> {
    return this.withRetry(async () => {
      return this.withDatabase(async () => {
        const result = await this.db
          .select()
          .from(taskTable)
          .where(and(eq(taskTable.name, name), eq(taskTable.agentId, this.agentId)));

        return result.map((row) => ({
          id: row.id as UUID,
          name: row.name,
          description: row.description ?? '',
          roomId: row.roomId as UUID,
          worldId: row.worldId as UUID,
          tags: row.tags || [],
          metadata: (row.metadata || {}) as TaskMetadata,
        }));
      });
    });
  }

  /**
   * Asynchronously retrieves a specific task by its ID.
   * @param id The UUID of the task to retrieve
   * @returns Promise resolving to the Task object if found, null otherwise
   */
  async getTask(id: UUID): Promise<Task | null> {
    return this.withRetry(async () => {
      return this.withDatabase(async () => {
        const result = await this.db
          .select()
          .from(taskTable)
          .where(and(eq(taskTable.id, id), eq(taskTable.agentId, this.agentId)))
          .limit(1);

        if (result.length === 0) {
          return null;
        }

        const row = result[0];
        return {
          id: row.id as UUID,
          name: row.name,
          description: row.description ?? '',
          roomId: row.roomId as UUID,
          worldId: row.worldId as UUID,
          tags: row.tags || [],
          metadata: (row.metadata || {}) as TaskMetadata,
        };
      });
    });
  }

  /**
   * Asynchronously updates an existing task in the database.
   * @param id The UUID of the task to update
   * @param task Partial Task object containing the fields to update
   * @returns Promise resolving when the update is complete
   */
  async updateTask(id: UUID, task: Partial<Task>): Promise<void> {
    await this.withRetry(async () => {
      await this.withDatabase(async () => {
        const updateValues: Partial<Task> = {};

        // Add fields to update if they exist in the partial task object
        if (task.name !== undefined) updateValues.name = task.name;
        if (task.description !== undefined) updateValues.description = task.description;
        if (task.roomId !== undefined) updateValues.roomId = task.roomId;
        if (task.worldId !== undefined) updateValues.worldId = task.worldId;
        if (task.tags !== undefined) updateValues.tags = task.tags;

        // Always update the updatedAt timestamp as a Date
        (updateValues as any).updatedAt = new Date();

        // Handle metadata updates - just set it directly without merging
        if (task.metadata !== undefined) {
          updateValues.metadata = task.metadata;
        }

        await this.db
          .update(taskTable)
          // createdAt is hella borked, number / Date
          .set(updateValues as any)
          .where(and(eq(taskTable.id, id), eq(taskTable.agentId, this.agentId)));
      });
    });
  }

  /**
   * Asynchronously deletes a task from the database.
   * @param id The UUID of the task to delete
   * @returns Promise resolving when the deletion is complete
   */
  async deleteTask(id: UUID): Promise<void> {
    return this.withDatabase(async () => {
      await this.db.delete(taskTable).where(eq(taskTable.id, id));
    });
  }

  async getMemoriesByWorldId(params: {
    worldId: UUID;
    count?: number;
    tableName?: string;
  }): Promise<Memory[]> {
    return this.withDatabase(async () => {
      // First, get all rooms for the given worldId
      const rooms = await this.db
        .select({ id: roomTable.id })
        .from(roomTable)
        .where(and(eq(roomTable.worldId, params.worldId), eq(roomTable.agentId, this.agentId)));

      if (rooms.length === 0) {
        return [];
      }

      const roomIds = rooms.map((room) => room.id as UUID);

      const memories = await this.getMemoriesByRoomIds({
        roomIds,
        tableName: params.tableName || 'messages',
        limit: params.count,
      });

      return memories;
    });
  }

  async deleteRoomsByWorldId(worldId: UUID): Promise<void> {
    return this.withDatabase(async () => {
      const rooms = await this.db
        .select({ id: roomTable.id })
        .from(roomTable)
        .where(and(eq(roomTable.worldId, worldId), eq(roomTable.agentId, this.agentId)));

      if (rooms.length === 0) {
        logger.debug(
          `No rooms found for worldId ${worldId} and agentId ${this.agentId} to delete.`
        );
        return;
      }

      const roomIds = rooms.map((room) => room.id as UUID);

      if (roomIds.length > 0) {
        await this.db.delete(logTable).where(inArray(logTable.roomId, roomIds));
        logger.debug(`Deleted logs for ${roomIds.length} rooms in world ${worldId}.`);

        await this.db.delete(participantTable).where(inArray(participantTable.roomId, roomIds));
        logger.debug(`Deleted participants for ${roomIds.length} rooms in world ${worldId}.`);

        const memoriesInRooms = await this.db
          .select({ id: memoryTable.id })
          .from(memoryTable)
          .where(inArray(memoryTable.roomId, roomIds));
        const memoryIdsInRooms = memoriesInRooms.map((m) => m.id as UUID);

        if (memoryIdsInRooms.length > 0) {
          await this.db
            .delete(embeddingTable)
            .where(inArray(embeddingTable.memoryId, memoryIdsInRooms));
          logger.debug(
            `Deleted embeddings for ${memoryIdsInRooms.length} memories in world ${worldId}.`
          );
          await this.db.delete(memoryTable).where(inArray(memoryTable.id, memoryIdsInRooms));
          logger.debug(`Deleted ${memoryIdsInRooms.length} memories in world ${worldId}.`);
        }

        await this.db.delete(roomTable).where(inArray(roomTable.id, roomIds));
        logger.debug(`Deleted ${roomIds.length} rooms for worldId ${worldId}.`);
      }
    });
  }

  // Message Server Database Operations

  /**
   * Creates a new message server in the central database
   */
  async createMessageServer(data: {
    id?: UUID; // Allow passing a specific ID
    name: string;
    sourceType: string;
    sourceId?: string;
    metadata?: any;
  }): Promise<{
    id: UUID;
    name: string;
    sourceType: string;
    sourceId?: string;
    metadata?: any;
    createdAt: Date;
    updatedAt: Date;
  }> {
    return this.withDatabase(async () => {
      const newId = data.id || (v4() as UUID);
      const now = new Date();
      const serverToInsert = {
        id: newId,
        name: data.name,
        sourceType: data.sourceType,
        sourceId: data.sourceId,
        metadata: data.metadata,
        createdAt: now,
        updatedAt: now,
      };

      await this.db.insert(messageServerTable).values(serverToInsert).onConflictDoNothing(); // In case the ID already exists

      // If server already existed, fetch it
      if (data.id) {
        const existing = await this.db
          .select()
          .from(messageServerTable)
          .where(eq(messageServerTable.id, data.id))
          .limit(1);
        if (existing.length > 0) {
          return {
            id: existing[0].id as UUID,
            name: existing[0].name,
            sourceType: existing[0].sourceType,
            sourceId: existing[0].sourceId || undefined,
            metadata: existing[0].metadata || undefined,
            createdAt: existing[0].createdAt,
            updatedAt: existing[0].updatedAt,
          };
        }
      }

      return serverToInsert;
    });
  }

  /**
   * Gets all message servers
   */
  async getMessageServers(): Promise<
    Array<{
      id: UUID;
      name: string;
      sourceType: string;
      sourceId?: string;
      metadata?: any;
      createdAt: Date;
      updatedAt: Date;
    }>
  > {
    return this.withDatabase(async () => {
      const results = await this.db.select().from(messageServerTable);
      return results.map((r) => ({
        id: r.id as UUID,
        name: r.name,
        sourceType: r.sourceType,
        sourceId: r.sourceId || undefined,
        metadata: r.metadata || undefined,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }));
    });
  }

  /**
   * Gets a message server by ID
   */
  async getMessageServerById(serverId: UUID): Promise<{
    id: UUID;
    name: string;
    sourceType: string;
    sourceId?: string;
    metadata?: any;
    createdAt: Date;
    updatedAt: Date;
  } | null> {
    return this.withDatabase(async () => {
      const results = await this.db
        .select()
        .from(messageServerTable)
        .where(eq(messageServerTable.id, serverId))
        .limit(1);
      return results.length > 0
        ? {
            id: results[0].id as UUID,
            name: results[0].name,
            sourceType: results[0].sourceType,
            sourceId: results[0].sourceId || undefined,
            metadata: results[0].metadata || undefined,
            createdAt: results[0].createdAt,
            updatedAt: results[0].updatedAt,
          }
        : null;
    });
  }

  /**
   * Creates a new channel
   */
  async createChannel(
    data: {
      id?: UUID; // Allow passing a specific ID
      messageServerId: UUID;
      name: string;
      type: string;
      sourceType?: string;
      sourceId?: string;
      topic?: string;
      metadata?: any;
    },
    participantIds?: UUID[]
  ): Promise<{
    id: UUID;
    messageServerId: UUID;
    name: string;
    type: string;
    sourceType?: string;
    sourceId?: string;
    topic?: string;
    metadata?: any;
    createdAt: Date;
    updatedAt: Date;
  }> {
    return this.withDatabase(async () => {
      const newId = data.id || (v4() as UUID);
      const now = new Date();
      const channelToInsert = {
        id: newId,
        messageServerId: data.messageServerId,
        name: data.name,
        type: data.type,
        sourceType: data.sourceType,
        sourceId: data.sourceId,
        topic: data.topic,
        metadata: data.metadata,
        createdAt: now,
        updatedAt: now,
      };

      await this.db.transaction(async (tx) => {
        await tx.insert(channelTable).values(channelToInsert);

        if (participantIds && participantIds.length > 0) {
          const participantValues = participantIds.map((userId) => ({
            channelId: newId,
            userId: userId,
          }));
          await tx.insert(channelParticipantsTable).values(participantValues).onConflictDoNothing();
        }
      });

      return channelToInsert;
    });
  }

  /**
   * Gets channels for a server
   */
  async getChannelsForServer(serverId: UUID): Promise<
    Array<{
      id: UUID;
      messageServerId: UUID;
      name: string;
      type: string;
      sourceType?: string;
      sourceId?: string;
      topic?: string;
      metadata?: any;
      createdAt: Date;
      updatedAt: Date;
    }>
  > {
    return this.withDatabase(async () => {
      const results = await this.db
        .select()
        .from(channelTable)
        .where(eq(channelTable.messageServerId, serverId));
      return results.map((r) => ({
        id: r.id as UUID,
        messageServerId: r.messageServerId as UUID,
        name: r.name,
        type: r.type,
        sourceType: r.sourceType || undefined,
        sourceId: r.sourceId || undefined,
        topic: r.topic || undefined,
        metadata: r.metadata || undefined,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }));
    });
  }

  /**
   * Gets channel details
   */
  async getChannelDetails(channelId: UUID): Promise<{
    id: UUID;
    messageServerId: UUID;
    name: string;
    type: string;
    sourceType?: string;
    sourceId?: string;
    topic?: string;
    metadata?: any;
    createdAt: Date;
    updatedAt: Date;
  } | null> {
    return this.withDatabase(async () => {
      const results = await this.db
        .select()
        .from(channelTable)
        .where(eq(channelTable.id, channelId))
        .limit(1);
      return results.length > 0
        ? {
            id: results[0].id as UUID,
            messageServerId: results[0].messageServerId as UUID,
            name: results[0].name,
            type: results[0].type,
            sourceType: results[0].sourceType || undefined,
            sourceId: results[0].sourceId || undefined,
            topic: results[0].topic || undefined,
            metadata: results[0].metadata || undefined,
            createdAt: results[0].createdAt,
            updatedAt: results[0].updatedAt,
          }
        : null;
    });
  }

  /**
   * Creates a message
   */
  async createMessage(data: {
    channelId: UUID;
    authorId: UUID;
    content: string;
    rawMessage?: any;
    sourceType?: string;
    sourceId?: string;
    metadata?: any;
    inReplyToRootMessageId?: UUID;
  }): Promise<{
    id: UUID;
    channelId: UUID;
    authorId: UUID;
    content: string;
    rawMessage?: any;
    sourceType?: string;
    sourceId?: string;
    metadata?: any;
    inReplyToRootMessageId?: UUID;
    createdAt: Date;
    updatedAt: Date;
  }> {
    return this.withDatabase(async () => {
      const newId = v4() as UUID;
      const now = new Date();
      const messageToInsert = {
        id: newId,
        channelId: data.channelId,
        authorId: data.authorId,
        content: data.content,
        rawMessage: data.rawMessage,
        sourceType: data.sourceType,
        sourceId: data.sourceId,
        metadata: data.metadata,
        inReplyToRootMessageId: data.inReplyToRootMessageId,
        createdAt: now,
        updatedAt: now,
      };

      await this.db.insert(messageTable).values(messageToInsert);
      return messageToInsert;
    });
  }

  /**
   * Gets messages for a channel
   */
  async getMessagesForChannel(
    channelId: UUID,
    limit: number = 50,
    beforeTimestamp?: Date
  ): Promise<
    Array<{
      id: UUID;
      channelId: UUID;
      authorId: UUID;
      content: string;
      rawMessage?: any;
      sourceType?: string;
      sourceId?: string;
      metadata?: any;
      inReplyToRootMessageId?: UUID;
      createdAt: Date;
      updatedAt: Date;
    }>
  > {
    return this.withDatabase(async () => {
      const conditions = [eq(messageTable.channelId, channelId)];
      if (beforeTimestamp) {
        conditions.push(lt(messageTable.createdAt, beforeTimestamp));
      }

      const query = this.db
        .select()
        .from(messageTable)
        .where(and(...conditions))
        .orderBy(desc(messageTable.createdAt))
        .limit(limit);

      const results = await query;
      return results.map((r) => ({
        id: r.id as UUID,
        channelId: r.channelId as UUID,
        authorId: r.authorId as UUID,
        content: r.content,
        rawMessage: r.rawMessage || undefined,
        sourceType: r.sourceType || undefined,
        sourceId: r.sourceId || undefined,
        metadata: r.metadata || undefined,
        inReplyToRootMessageId: r.inReplyToRootMessageId as UUID | undefined,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }));
    });
  }

  /**
   * Deletes a message
   */
  async deleteMessage(messageId: UUID): Promise<void> {
    return this.withDatabase(async () => {
      await this.db.delete(messageTable).where(eq(messageTable.id, messageId));
    });
  }

  /**
   * Updates a channel
   */
  async updateChannel(
    channelId: UUID,
    updates: { name?: string; participantCentralUserIds?: UUID[]; metadata?: any }
  ): Promise<{
    id: UUID;
    messageServerId: UUID;
    name: string;
    type: string;
    sourceType?: string;
    sourceId?: string;
    topic?: string;
    metadata?: any;
    createdAt: Date;
    updatedAt: Date;
  }> {
    return this.withDatabase(async () => {
      const now = new Date();

      await this.db.transaction(async (tx) => {
        // Update channel details
        const updateData: any = { updatedAt: now };
        if (updates.name !== undefined) updateData.name = updates.name;
        if (updates.metadata !== undefined) updateData.metadata = updates.metadata;

        await tx.update(channelTable).set(updateData).where(eq(channelTable.id, channelId));

        // Update participants if provided
        if (updates.participantCentralUserIds !== undefined) {
          // Remove existing participants
          await tx
            .delete(channelParticipantsTable)
            .where(eq(channelParticipantsTable.channelId, channelId));

          // Add new participants
          if (updates.participantCentralUserIds.length > 0) {
            const participantValues = updates.participantCentralUserIds.map((userId) => ({
              channelId: channelId,
              userId: userId,
            }));
            await tx
              .insert(channelParticipantsTable)
              .values(participantValues)
              .onConflictDoNothing();
          }
        }
      });

      // Return updated channel details
      const updatedChannel = await this.getChannelDetails(channelId);
      if (!updatedChannel) {
        throw new Error(`Channel ${channelId} not found after update`);
      }
      return updatedChannel;
    });
  }

  /**
   * Deletes a channel and all its associated data
   */
  async deleteChannel(channelId: UUID): Promise<void> {
    return this.withDatabase(async () => {
      await this.db.transaction(async (tx) => {
        // Delete all messages in the channel (cascade delete will handle this, but explicit is better)
        await tx.delete(messageTable).where(eq(messageTable.channelId, channelId));

        // Delete all participants (cascade delete will handle this, but explicit is better)
        await tx
          .delete(channelParticipantsTable)
          .where(eq(channelParticipantsTable.channelId, channelId));

        // Delete the channel itself
        await tx.delete(channelTable).where(eq(channelTable.id, channelId));
      });
    });
  }

  /**
   * Adds participants to a channel
   */
  async addChannelParticipants(channelId: UUID, userIds: UUID[]): Promise<void> {
    return this.withDatabase(async () => {
      if (!userIds || userIds.length === 0) return;

      const participantValues = userIds.map((userId) => ({
        channelId: channelId,
        userId: userId,
      }));

      await this.db
        .insert(channelParticipantsTable)
        .values(participantValues)
        .onConflictDoNothing();
    });
  }

  /**
   * Gets participants for a channel
   */
  async getChannelParticipants(channelId: UUID): Promise<UUID[]> {
    return this.withDatabase(async () => {
      const results = await this.db
        .select({ userId: channelParticipantsTable.userId })
        .from(channelParticipantsTable)
        .where(eq(channelParticipantsTable.channelId, channelId));

      return results.map((r) => r.userId as UUID);
    });
  }

  /**
   * Adds an agent to a server
   */
  async addAgentToServer(serverId: UUID, agentId: UUID): Promise<void> {
    return this.withDatabase(async () => {
      await this.db
        .insert(serverAgentsTable)
        .values({
          serverId,
          agentId,
        })
        .onConflictDoNothing();
    });
  }

  /**
   * Gets agents for a server
   */
  async getAgentsForServer(serverId: UUID): Promise<UUID[]> {
    return this.withDatabase(async () => {
      const results = await this.db
        .select({ agentId: serverAgentsTable.agentId })
        .from(serverAgentsTable)
        .where(eq(serverAgentsTable.serverId, serverId));

      return results.map((r) => r.agentId as UUID);
    });
  }

  /**
   * Removes an agent from a server
   */
  async removeAgentFromServer(serverId: UUID, agentId: UUID): Promise<void> {
    return this.withDatabase(async () => {
      await this.db
        .delete(serverAgentsTable)
        .where(
          and(eq(serverAgentsTable.serverId, serverId), eq(serverAgentsTable.agentId, agentId))
        );
    });
  }

  /**
   * Finds or creates a DM channel between two users
   */
  async findOrCreateDmChannel(
    user1Id: UUID,
    user2Id: UUID,
    messageServerId: UUID
  ): Promise<{
    id: UUID;
    messageServerId: UUID;
    name: string;
    type: string;
    sourceType?: string;
    sourceId?: string;
    topic?: string;
    metadata?: any;
    createdAt: Date;
    updatedAt: Date;
  }> {
    return this.withDatabase(async () => {
      const ids = [user1Id, user2Id].sort();
      const dmChannelName = `DM-${ids[0]}-${ids[1]}`;

      const existingChannels = await this.db
        .select()
        .from(channelTable)
        .where(
          and(
            eq(channelTable.type, ChannelType.DM),
            eq(channelTable.name, dmChannelName),
            eq(channelTable.messageServerId, messageServerId)
          )
        )
        .limit(1);

      if (existingChannels.length > 0) {
        return {
          id: existingChannels[0].id as UUID,
          messageServerId: existingChannels[0].messageServerId as UUID,
          name: existingChannels[0].name,
          type: existingChannels[0].type,
          sourceType: existingChannels[0].sourceType || undefined,
          sourceId: existingChannels[0].sourceId || undefined,
          topic: existingChannels[0].topic || undefined,
          metadata: existingChannels[0].metadata || undefined,
          createdAt: existingChannels[0].createdAt,
          updatedAt: existingChannels[0].updatedAt,
        };
      }

      // Create new DM channel
      return this.createChannel(
        {
          messageServerId,
          name: dmChannelName,
          type: ChannelType.DM,
          metadata: { user1: ids[0], user2: ids[1] },
        },
        ids
      );
    });
  }

  /**
   * Clean up old embeddings to free memory.
   * Removes embeddings older than the specified number of days for the given agent.
   * @param {UUID} agentId - The agent ID to clean embeddings for
   * @param {number} retentionDays - Number of days to retain embeddings (default: 7)
   * @returns {Promise<number>} Number of embeddings deleted
   */
  async cleanupOldEmbeddings(agentId: UUID, retentionDays: number = 7): Promise<number> {
    return this.withDatabase(async () => {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

      // First get the memory IDs that will be cleaned up
      const oldMemories = await this.db
        .select({ id: memoryTable.id })
        .from(memoryTable)
        .where(and(eq(memoryTable.agentId, agentId), lt(memoryTable.createdAt, cutoffDate)));

      if (oldMemories.length === 0) {
        logger.debug(`No old embeddings found for agent ${agentId}`);
        return 0;
      }

      const memoryIds = oldMemories.map((m) => m.id);

      // Delete embeddings for these memories
      const deletedEmbeddings = await this.db
        .delete(embeddingTable)
        .where(inArray(embeddingTable.memoryId, memoryIds));

      logger.info(
        `Cleaned up ${oldMemories.length} old embeddings for agent ${agentId} (older than ${retentionDays} days)`
      );
      return oldMemories.length;
    });
  }

  /**
   * Clean up cache entries that have expired.
   * @param {UUID} agentId - The agent ID to clean cache for
   * @returns {Promise<number>} Number of cache entries deleted
   */
  async cleanupExpiredCache(agentId: UUID): Promise<number> {
    return this.withDatabase(async () => {
      const now = new Date();

      const deletedEntries = await this.db
        .delete(cacheTable)
        .where(and(eq(cacheTable.agentId, agentId), lt(cacheTable.expiresAt, now)));

      if ((deletedEntries as any).rowCount > 0) {
        logger.debug(
          `Cleaned up ${(deletedEntries as any).rowCount} expired cache entries for agent ${agentId}`
        );
      }

      return (deletedEntries as any).rowCount || 0;
    });
  }
}

// Import tables at the end to avoid circular dependencies
