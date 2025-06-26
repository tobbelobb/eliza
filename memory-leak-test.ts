#!/usr/bin/env bun
/**
 * Memory Leak Test Script for ElizaOS
 *
 * This script monitors memory usage during agent startup and running
 * to validate that memory leaks have been fixed.
 *
 * Tests both:
 * 1. Runtime-level memory leaks (stateCache, TaskService timers)
 * 2. Server-level memory leaks (Socket.IO agent unregistration)
 */

import { startAgents } from './packages/cli/src/commands/start/actions/server-start';
import { getElizaCharacter } from './packages/cli/src/characters/eliza';
import { logger } from '@elizaos/core';
import { io } from 'socket.io-client';

interface MemorySnapshot {
  timestamp: number;
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
}

class MemoryMonitor {
  private snapshots: MemorySnapshot[] = [];
  private interval: NodeJS.Timeout | null = null;

  start(intervalMs: number = 5000) {
    this.interval = setInterval(() => {
      const mem = process.memoryUsage();
      this.snapshots.push({
        timestamp: Date.now(),
        rss: mem.rss,
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
        external: mem.external,
      });

      // Keep only last 100 snapshots to prevent this monitor from leaking
      if (this.snapshots.length > 100) {
        this.snapshots = this.snapshots.slice(-100);
      }

      logger.info(
        `Memory: RSS=${Math.round(mem.rss / 1024 / 1024)}MB, Heap=${Math.round(mem.heapUsed / 1024 / 1024)}MB`
      );
    }, intervalMs);
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  getGrowthRate(): number {
    if (this.snapshots.length < 2) return 0;

    const first = this.snapshots[0];
    const last = this.snapshots[this.snapshots.length - 1];
    const timeDiff = (last.timestamp - first.timestamp) / 1000; // seconds
    const memDiff = last.rss - first.rss; // bytes

    return memDiff / timeDiff; // bytes per second
  }

  getReport(): string {
    if (this.snapshots.length === 0) return 'No memory snapshots taken';

    const first = this.snapshots[0];
    const last = this.snapshots[this.snapshots.length - 1];
    const growthRate = this.getGrowthRate();

    return `
Memory Report:
- Initial RSS: ${Math.round(first.rss / 1024 / 1024)}MB
- Final RSS: ${Math.round(last.rss / 1024 / 1024)}MB
- Growth Rate: ${Math.round(growthRate / 1024)} KB/s
- Total Time: ${Math.round((last.timestamp - first.timestamp) / 1000)}s
- Status: ${growthRate > 1024 ? 'MEMORY LEAK DETECTED' : 'Memory usage stable'}
`;
  }
}

async function testSocketConnections(port: number) {
  console.log('🔌 Testing Socket.IO connection/disconnection cycles...');

  const connections: any[] = [];
  const agentId = 'test-agent-uuid-' + Math.random().toString(36).substr(2, 9);

  // Create multiple connections and disconnect them
  for (let i = 0; i < 10; i++) {
    const socket = io(`http://localhost:${port}`, {
      transports: ['websocket'],
    });

    connections.push(socket);

    // Simulate sending a message to associate socket with agent
    socket.emit('SEND_MESSAGE', {
      channelId: 'test-channel-' + i,
      senderId: agentId,
      message: 'Test message ' + i,
      serverId: '0',
    });

    // Wait a bit
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  console.log(`📡 Created ${connections.length} socket connections`);

  // Disconnect all connections
  for (const socket of connections) {
    socket.disconnect();
  }

  console.log('🔌 Disconnected all socket connections');

  // Wait for cleanup
  await new Promise((resolve) => setTimeout(resolve, 1000));
}

async function runMemoryLeakTest() {
  console.log('🔍 Starting ElizaOS Memory Leak Test...');

  const monitor = new MemoryMonitor();

  try {
    // Start memory monitoring
    monitor.start(2000); // Monitor every 2 seconds

    console.log('📊 Memory monitoring started...');

    // Start agents
    console.log('🚀 Starting agents...');
    const elizaCharacter = getElizaCharacter();

    await startAgents({
      characters: [elizaCharacter],
      port: 3001, // Use different port to avoid conflicts
    });

    console.log('✅ Agents started successfully');

    // Wait for server to be fully ready
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Test socket connections (this tests the server-level memory leak fix)
    await testSocketConnections(3001);

    // Let agents run for 2 minutes to test runtime-level leaks
    console.log('⏱️  Monitoring memory for 2 minutes...');
    await new Promise((resolve) => setTimeout(resolve, 120000));

    // Stop monitoring
    monitor.stop();

    // Print report
    console.log(monitor.getReport());

    // Check for memory leaks
    const growthRate = monitor.getGrowthRate();
    if (growthRate > 1024) {
      // More than 1KB/s growth
      console.log('❌ MEMORY LEAK DETECTED!');
      process.exit(1);
    } else {
      console.log('✅ Memory usage appears stable');
      process.exit(0);
    }
  } catch (error) {
    console.error('❌ Test failed:', error);
    monitor.stop();
    process.exit(1);
  }
}

if (import.meta.main) {
  runMemoryLeakTest().catch(console.error);
}
