This is the default sandbox workspace for the local Bielik agent.

Run from the project root:

  .\start-bielik.ps1

To point the agent at another folder:

  .\start-bielik.ps1 -Workspace C:\path\to\folder

The agent's built-in file tools reject paths outside the chosen workspace.
