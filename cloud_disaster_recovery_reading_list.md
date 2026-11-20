# Cloud Disaster Recovery --- Articles, Engineering Write-ups & Research

**Curated reading list \| Updated: 20 November 2026**

This document collects resources specifically about **cloud disaster
recovery (DR)**: planning for major outages, restoring data and
applications, regional failover, backup validation, replication,
recovery testing, and business continuity.

> **Scope note:** High availability (HA) and disaster recovery are
> related but not identical. HA handles many component failures
> automatically; DR is the planned recovery of workloads after a wider
> disruption, such as a regional outage, destructive data corruption, or
> loss of a production environment.

------------------------------------------------------------------------

## 1. Google Cloud

Google Cloud has a particularly useful, connected series of
disaster-recovery architecture guides. Start with the planning guide,
then read the building blocks and scenario guides.

1.  **[Disaster recovery planning
    guide](https://docs.cloud.google.com/architecture/dr-scenarios-planning-guide)**\
    An end-to-end guide to designing a DR plan. Covers recovery
    requirements, preparation, security, access, testing, and making
    recovery procedures executable.

2.  **[Disaster recovery building
    blocks](https://docs.cloud.google.com/architecture/dr-scenarios-building-blocks)**\
    The Google Cloud services and cross-platform technologies that can
    be combined to build a DR solution.

3.  **[Disaster recovery scenarios for
    data](https://docs.cloud.google.com/architecture/dr-scenarios-for-data)**\
    Backup and recovery of files, databases, logs, and other data.
    Discusses recovery from backups and using Google Cloud as a recovery
    destination when production is on another cloud.

4.  **[Disaster recovery scenarios for
    applications](https://docs.cloud.google.com/architecture/dr-scenarios-for-applications)**\
    Application recovery patterns, including cold, warm, and hot
    approaches, with example architectures and failover steps.

5.  **[Architecting disaster recovery for cloud infrastructure
    outages](https://docs.cloud.google.com/architecture/disaster-recovery)**\
    A deeper architecture guide to zonal and regional outages, RTO/RPO,
    replication, and designing workloads to tolerate infrastructure
    failures.

6.  **[Reliability and disaster recovery
    resources](https://docs.cloud.google.com/architecture/reliability)**\
    Google Cloud's wider collection of reliability and DR architecture
    resources.

**Suggested order:** 1 → 2 → 3 → 4 → 5.

------------------------------------------------------------------------

## 2. Meta / Facebook Engineering

Meta's engineering blog is valuable for real-world lessons from
operating databases and infrastructure at global scale.

1.  **[Continuous MySQL backup validation: Restoring
    backups](https://engineering.fb.com/2016/10/28/data-infrastructure/continuous-mysql-backup-validation-restoring-backups/)**\
    A particularly relevant engineering article. Meta describes a system
    that continuously restores database backups to verify that they are
    usable. It discusses restore scheduling, monitoring, and validating
    recovery rather than merely assuming a backup is good.

2.  **[Power Loss Siren: Making Meta resilient to power loss
    events](https://engineering.fb.com/2021/12/16/data-center-engineering/power-loss-siren/)**\
    Infrastructure resilience and preparation for power-loss events
    across data-centre systems. Useful for understanding the physical
    infrastructure risks that DR planning must consider.

3.  **[StateService: Automating recovery of third-party
    services](https://engineering.fb.com/2018/10/04/open-source/stateservice/)**\
    An engineering write-up about automating service recovery. Relevant
    to recovery orchestration and reducing manual intervention.

*Note: Meta's engineering posts are practical engineering case studies,
not general-purpose cloud DR implementation manuals.*

------------------------------------------------------------------------

## 3. Amazon Web Services (AWS)

1.  **[Disaster Recovery of Workloads on AWS: Recovery in the
    Cloud](https://docs.aws.amazon.com/whitepapers/latest/disaster-recovery-workloads-on-aws/)**\
    AWS's main DR whitepaper. Covers planning, the shared-responsibility
    model, recovery strategies, detection, testing, RTO, and RPO.

2.  **[Disaster recovery is different in the
    cloud](https://docs.aws.amazon.com/whitepapers/latest/disaster-recovery-workloads-on-aws/disaster-recovery-is-different-in-the-cloud.html)**\
    Explains how cloud-based DR differs from traditional approaches and
    how cloud capabilities change recovery design.

3.  **[Disaster recovery options in the
    cloud](https://docs.aws.amazon.com/whitepapers/latest/disaster-recovery-workloads-on-aws/disaster-recovery-options-in-the-cloud.html)**\
    Compares cloud recovery strategies, including backup and restore,
    pilot light, warm standby, and multi-site active/active.

4.  **[Testing disaster
    recovery](https://docs.aws.amazon.com/whitepapers/latest/disaster-recovery-workloads-on-aws/testing-disaster-recovery.html)**\
    Why and how to test recovery plans, including validating that
    procedures meet their recovery objectives.

------------------------------------------------------------------------

## 4. Microsoft Azure

1.  **[Architecture strategies for disaster
    recovery](https://learn.microsoft.com/en-us/azure/well-architected/reliability/disaster-recovery)**\
    Azure Well-Architected guidance covering recovery-aware
    architecture, data integrity, recovery targets, failover, and DR
    drills.

2.  **[Develop a disaster recovery plan for multi-region
    deployments](https://learn.microsoft.com/en-us/azure/well-architected/design-guides/disaster-recovery)**\
    Practical guidance for planning, documenting, and testing
    multi-region recovery. Covers workload criticality and
    backup/restore, cold standby, warm standby, and active/active
    strategies.

3.  **[Azure-to-Azure disaster recovery
    architecture](https://learn.microsoft.com/en-us/azure/site-recovery/azure-to-azure-architecture)**\
    Explains Azure Site Recovery architecture, VM replication to a
    target region, recovery points, failover, and failback.

4.  **[Azure reliability
    documentation](https://learn.microsoft.com/en-us/azure/reliability)**\
    Overview of Azure reliability, regions, availability zones, and
    service-specific reliability guidance.

5.  **[Reliability design
    principles](https://learn.microsoft.com/en-us/azure/well-architected/reliability/principles)**\
    Includes the principle of designing for recovery and maintaining
    tested, documented recovery plans.

------------------------------------------------------------------------

## 5. IBM Cloud

1.  **[IBM Cloud Resiliency](https://cloud.ibm.com/docs/resiliency)**\
    Broad collection of IBM Cloud guidance on disaster recovery
    architectures, standby approaches, active/active, capacity in the
    recovery region, failback, and planning.

2.  **[How IBM Cloud prepares for disaster
    recovery](https://cloud.ibm.com/docs/resiliency?topic=resiliency-disaster-recovery)**\
    Describes IBM's DR planning requirements, including recovery
    workflows, restore-point objectives, alternative computing
    facilities, and keeping plans current.

------------------------------------------------------------------------

## 6. Oracle Cloud Infrastructure (OCI)

1.  **[Disaster
    Recovery](https://docs.oracle.com/en-us/iaas/Content/cloud-adoption-framework/disaster-recovery.htm)**\
    OCI guidance on preparing for and recovering from disruptive events,
    with an emphasis on restoring workloads and maintaining business
    continuity.

2.  **[Extreme
    Reliability](https://docs.oracle.com/en-us/iaas/Content/cloud-adoption-framework/extreme-reliability.htm)**\
    Discusses high availability and DR architecture, including
    multi-region deployment and replication across regions.

3.  **[Plan Your Disaster Recovery
    Strategy](https://docs.oracle.com/en/solutions/oci-best-practices/plan-your-disaster-recovery-strategy.html)**\
    Practical planning guidance: prioritising workloads, defining
    RTO/RPO, choosing recovery approaches, and rehearsing the plan.

4.  **[Reliable and Resilient Cloud Topology
    Practices](https://docs.oracle.com/en/solutions/oci-best-practices/reliable-and-resilient-cloud-topology-practices1.html)**\
    Covers failure and disaster management, documented recovery plans,
    testing, and application recovery preparation.

------------------------------------------------------------------------

## 7. Alibaba Cloud

1.  **[Disaster Recovery Architecture & Resilience
    Overview](https://www.alibabacloud.com/help/en/well-architected/disaster-tolerance/)**\
    Alibaba Cloud Well-Architected guidance on disaster recovery,
    production and standby centres, RTO/RPO, and active/active designs.

------------------------------------------------------------------------

## 8. Academic Research Papers

These papers are useful for understanding the research landscape,
identifying techniques and challenges, and finding references for a
literature review.

1.  **[Disaster Recovery in Cloud Computing: A
    Survey](https://doi.org/10.5539/cis.v7n4p39) --- Khoshkholghi et
    al. (2014)**\
    A survey of cloud DR concepts, mechanisms, challenges, proposed
    solutions, and open research issues. A good foundational paper for a
    literature review.

2.  **[Backup & Data Recovery in Cloud Computing: A Systematic Mapping
    Study](https://doi.org/10.58944/pwhk4843) --- Plaka (2022)**\
    A systematic mapping study evaluating 45 papers published between
    2010 and 2020. Organises research around disaster causes, data loss,
    business continuity, security, privacy, backup, and recovery.

3.  **[Evaluating Organizational Preparedness for Disaster Recovery in
    Cloud-Based
    Enterprises](https://doi.org/10.1016/j.procs.2026.06.073) ---
    Procedia Computer Science (2026)**\
    Research on organisational readiness for cloud DR, including
    governance, training, documentation, risk assessment, and
    coordination. Useful for the people and process dimensions of DR,
    not just technical architecture.

------------------------------------------------------------------------

## 9. Key Concepts to Track While Reading

  -----------------------------------------------------------------------
  Concept                             Meaning
  ----------------------------------- -----------------------------------
  **RTO --- Recovery Time Objective** Maximum acceptable time to restore
                                      a service after a disruption.

  **RPO --- Recovery Point            Maximum acceptable amount of data
  Objective**                         loss, measured in time.

  **Failover**                        Moving service operation from the
                                      primary environment to a recovery
                                      environment.

  **Failback**                        Returning operations to the primary
                                      environment after it is restored.

  **Backup and restore**              Recovering data and systems from
                                      previously saved copies.

  **Replication**                     Keeping copies of data in another
                                      zone, region, or cloud.

  **Cold standby**                    Recovery environment is mostly
                                      inactive until needed.

  **Warm standby**                    A reduced-capacity recovery
                                      environment is already running.

  **Active/active**                   Multiple environments serve traffic
                                      at the same time.

  **Recovery testing**                Practising and validating that
                                      backups, systems, and procedures
                                      can actually restore service.
  -----------------------------------------------------------------------

------------------------------------------------------------------------

## 10. Recommended Reading Path

For a focused introduction followed by deeper research:

1.  Read Google's **Disaster recovery planning guide** for the overall
    process.
2.  Read Google's **Disaster recovery scenarios for data** and
    **applications** for concrete recovery architectures.
3.  Read Meta's **Continuous MySQL backup validation** for a real
    engineering example of testing restorability.
4.  Read the AWS whitepaper to compare the major DR strategies and their
    cost/recovery trade-offs.
5.  Read Microsoft's multi-region DR plan and IBM's resiliency guidance
    to compare provider approaches.
6.  Read the 2014 survey and 2022 systematic mapping study to build an
    academic foundation.

### Possible research directions

-   Automated disaster detection and failover in cloud environments.
-   Cross-region and cross-cloud disaster recovery.
-   Backup integrity verification and automated restore testing.
-   Reducing RTO and RPO while controlling infrastructure cost.
-   Recovery from ransomware, accidental deletion, and data corruption.
-   Disaster recovery for containerised and Kubernetes-based
    applications.
-   Consistency and data-loss trade-offs in synchronous versus
    asynchronous replication.
-   Measuring and comparing DR strategies across cloud providers.

------------------------------------------------------------------------

## Notes on using this list

-   Provider documentation describes that provider's services and
    recommended architectures; it should not automatically be treated as
    a neutral comparison.
-   Engineering blogs such as Meta's are implementation case studies and
    may describe systems built for that company's scale.
-   For academic work, use the paper's DOI or publisher page to verify
    publication details and follow its references to locate earlier
    research.
-   A backup is not a complete DR plan by itself. A robust plan also
    needs recoverable infrastructure, application dependencies, access
    controls, tested runbooks, communications, and regular exercises.
