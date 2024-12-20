import {
    ActionExample,
    IAgentRuntime,
    Memory,
    type Action,
    HandlerCallback,
    State,
} from "@ai16z/eliza";

export const ragciteAction: Action = {
    name: "RAGCITE",
    similes: ["CITE_RAG", "QUOTE_RAG", "RAGQUOTE", "CITE_KNOWLEDGE", "KNOWLEDGECITE"],
    validate: async (runtime: IAgentRuntime, _message: Memory) => {
        return true;
    },
    description:
        "Call this action if the user has asked a direct question within your area of expertise or interest. Use RAGCITE any time the user wants precise, exact, or detailed knowledge from you. Do not use RAGCITE during casual chit chat.",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: any,
        callback: HandlerCallback
    ): Promise<boolean> => {
        try {
            const bestMatch = state.knowledgeData?.[0] as Memory;
            const secondBestMatch = state.knowledgeData?.[1] as Memory;
            console.log("bestMatch=", bestMatch);
            console.log("secondBestMatch=", secondBestMatch);


            // Check if the best one is significantly better than the second best
            if ((bestMatch.similarity / secondBestMatch.similarity) > 0.94) {
                console.log("No clearly dominant knowledge match found", bestMatch);
                callback({ text: "", content: { noKnowledge: true } }, []);
                return true;
            }

            console.log("Found relevant knowledge", bestMatch);

            // Send the response with the knowledge item
            const responseContent = {
                text: `Here's a relevant entry from my knowledge base:\n\"${bestMatch.content.text}\"`,
                content: {
                    knowledgeItem: bestMatch,
                    similarity: bestMatch.similarity
                }
            };
            await callback(responseContent, []);

            return true;
        } catch (error) {
            console.error("Error in RAGCITE handler:", error);
            callback({
                text: "I encountered an error while trying to process your question. Please try asking in a different way.",
                content: { error: error instanceof Error ? error.message : String(error) }
            }, []);
            return false;
        }
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: { text: "Is Hangprinter a huge machine with a tiny footprint?" },
            },
            {
                user: "{{user2}}",
                content: { text: "", action: "RAGCITE" },
            }
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "What is the capital of France?" },
            },
            {
                user: "{{user2}}",
                content: { text: "", action: "RAGCITE" },
            }
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "Can you explain how photosynthesis works in detail?" },
            },
            {
                user: "{{user2}}",
                content: { text: "", action: "RAGCITE" },
            }
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "What were the main causes of World War II?" },
            },
            {
                user: "{{user2}}",
                content: { text: "", action: "RAGCITE" },
            }
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "How does quantum entanglement work?" },
            },
            {
                user: "{{user2}}",
                content: { text: "", action: "RAGCITE" },
            }
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "What are the key principles of machine learning?" },
            },
            {
                user: "{{user2}}",
                content: { text: "", action: "RAGCITE" },
            }
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "Can you cite some research about climate change impacts?" },
            },
            {
                user: "{{user2}}",
                content: { text: "", action: "RAGCITE" },
            }
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "What exactly happens during a solar eclipse?" },
            },
            {
                user: "{{user2}}",
                content: { text: "", action: "RAGCITE" },
            }
        ]
    ] as ActionExample[][],
} as Action;
