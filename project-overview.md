

We need to start scaffolding a UI. In general:
- create the covenant routes needed on the backend but have them simply return dummy data for now
- use tailwind with daisyui. Prefer daisyui classes when possible 
- write reusable components
- use react router
- use the heroicons library when you need icons


Fleet is an application where users can spawn and orchestrate AI agents to ship faster. These agents each spawn in their own isolated docker environment with custom context systems


# Home `/`

The home page should display a simple welcome message with a status update on any agents that are running.

The home page should have a sidebar with several options:
```
<folder icon> projects
    ... (one for every project)
    + new project
<shield icon> armory
```

This sidebar should display on every page


# Projects `/project/[project]`

There will be several subroutes to each project:
- `/project/[project]/` - contains a kanban board where agents can be assigned to complete tasks
- `/project/[project]/agents` - allows users to create agents by specifying what model to use and give the agent custom tools and skills


# New Project
The new project page should have inputs for:
- git repo url
- environment (docker image)
- subdirectory (optional)

# Armory `/armory`

Don't worry about this for now. Leave it as a WIP
