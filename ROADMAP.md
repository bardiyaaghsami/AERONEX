# Development Roadmap

This roadmap separates implemented and evaluated
capabilities from planned development and research.

## Milestones

| Milestone | Completed / Current Evidence | Next Development |
|---|---|---|
| M1 — Simulation | ROS 2 Jazzy, Gazebo Harmonic and PX4 SITL | More dynamic scenarios |
| M2 — Sensors | RGB-D, IMU and LiDAR integration | Robustness experiments |
| M3 — Dataset | 41 GB dataset and ground truth | Public sample dataset |
| M4 — Multi-SLAM | Benchmark results and failure analysis | Five or more runs per pipeline |
| M5 — 3D Mapping | RTAB-Map geometric map evaluation | Additional mapping baselines |
| M6 — Validation | Tracking and resource metrics | CI and regression tests |
| M7 — Public Release | Benchmark summary prepared locally | Review and publish v0.1.0-alpha |
| M8 — Autonomous Navigation | Mapping and simulation foundation | Planning and obstacle avoidance |
| M9 — Fly-Brain Planning | Research topic defined | Neural path integration and planning experiments |
| M10 — MuJoCo | Planned | Dynamics and learning-based control |
| M11 — Isaac Sim | Planned | Simulation integration and synthetic data |
| M12 — VLM | Planned | Semantic understanding and task planning |
| M13 — VLA | Planned | Vision-language-conditioned actions |
| M14 — Vertical Drift | Error characterised experimentally | ICP/Force4DoF and barometric fusion |
| M15 — Sim-to-Sim Validation | Planned | Cross-simulator consistency studies |

## Immediate Priorities

1. Complete the public GitHub showcase.
2. Validate the README, images and documentation.
3. Audit repository content and third-party licences.
4. Evaluate live RTAB-Map localisation and height correction.
5. Establish an autonomous-navigation baseline.
6. Repeat the SLAM benchmark across additional runs.

## Research Scope

The longer-term research programme includes:

- Navigation inspired by the fruit-fly central complex
- Model-based and learning-based control in MuJoCo
- Isaac Sim integration and synthetic sensor experiments
- VLM-based semantic mission planning
- VLA-based action generation with independent safety checks

## Status Definitions

**Completed:** Implemented and demonstrated.

**Evaluated:** Supported by experimental measurements.

**Planned:** Intended future implementation.

**Research:** Exploratory work without a validated result.

The roadmap describes intended development rather
than completed functionality.
